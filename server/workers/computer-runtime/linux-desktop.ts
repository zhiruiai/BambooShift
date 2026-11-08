import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  LINUX_DESKTOP_MAX_PNG_BYTES,
  LINUX_DESKTOP_MAX_REPLY_BYTES,
  LINUX_DESKTOP_MAX_REQUEST_BYTES,
  LINUX_DESKTOP_MAX_TEXT_UNITS,
  LINUX_DESKTOP_TIMEOUT_MS,
  parseDesktopSession,
  sameDesktopSession,
  type LinuxDesktopErrorCode,
  type LinuxDesktopFrame,
  type LinuxDesktopRequest,
  type LinuxDesktopSession,
} from '../../../shared/linux-desktop.js';
import {
  validateDesktopInput,
  type DesktopAdapter,
  type DesktopDisplay,
  type DesktopInput,
  type DesktopStatus,
} from './desktop.js';

export interface LinuxDesktopAdapterOptions {
  interpreterPath: string;
  helperPath: string;
  manifestPath: string;
  expectedSessionId?: string;
  expectedGeneration?: string;
  /** Test-only selection; no environment variable can select a display. */
  platform?: NodeJS.Platform;
  /** Bounded helper deadline, for controlled process tests. */
  timeoutMs?: number;
  /** A slow cleanup disables this instance but never kills the supervisor first. */
  cleanupWaitMs?: number;
}
export interface LinuxDesktopMaintenanceState {
  cleanupUnknown: boolean;
  activeHelpers: number;
}
const maintenanceStates = new WeakMap<DesktopAdapter, () => LinuxDesktopMaintenanceState>();
/** Trusted internal signal only. Desktop status text is never a maintenance credential. */
export function linuxDesktopMaintenanceState(
  adapter?: DesktopAdapter,
): LinuxDesktopMaintenanceState | undefined {
  return adapter && maintenanceStates.get(adapter)?.();
}

const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const validSession = (value: unknown): value is LinuxDesktopSession => !!parseDesktopSession(value);
const sameSession = (a: LinuxDesktopSession, b: LinuxDesktopSession) => sameDesktopSession(a, b);
const errorMessages: Record<LinuxDesktopErrorCode, string> = {
  CANCELLED: '虚拟桌面操作已取消；可能已有部分输入，请先检查画面。',
  TIMEOUT: '虚拟桌面操作超时；可能已有部分输入，请检查画面后再操作。',
  STALE_FRAME: '虚拟桌面画面已变化，请重新截图后再操作。',
  STALE_SESSION: '虚拟桌面会话已变更，请重新连接并批准操作。',
  INVALID_REQUEST: '虚拟桌面控制协议不匹配，请检查远程电脑配置。',
  DESKTOP_UNAVAILABLE: '专用虚拟桌面不可用，请检查远程电脑配置。',
  INPUT_FAILED: '虚拟桌面未确认输入完成，请查看画面后重新操作。',
  CAPTURE_FAILED: '无法获取虚拟桌面画面，请稍后重试。',
  CLEANUP_UNKNOWN: '无法确认虚拟桌面输入已释放，当前连接已停用。',
};
const recoverable = new Set<LinuxDesktopErrorCode>([
  'CANCELLED',
  'TIMEOUT',
  'STALE_FRAME',
  'INPUT_FAILED',
  'CAPTURE_FAILED',
]);
const linuxModifiers: Record<string, string> = {
  controlormeta: 'ctrl',
  control: 'ctrl',
  meta: 'super',
  command: 'super',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

function validateLinuxInput(input: DesktopInput) {
  validateDesktopInput(input);
  // Reject ordinary invalid user input here, before it can be mistaken for a
  // helper protocol failure that would permanently disable a valid session.
  if (input.type === 'key') {
    const modifiers = input.key
      .toLowerCase()
      .split('+')
      .slice(0, -1)
      .map((key) => linuxModifiers[key]);
    if (new Set(modifiers).size !== modifiers.length) throw new Error('组合键包含重复的修饰键。');
  }
  // With Unicode mode, valid surrogate pairs form one code point outside this
  // range; only an unpaired UTF-16 unit matches.
  if (input.type === 'type' && /[\uD800-\uDFFF]/u.test(input.text))
    throw new Error('输入文字包含不完整的 Unicode 字符，请重新输入。');
  if (input.type === 'type' && input.text.length > LINUX_DESKTOP_MAX_TEXT_UNITS)
    throw new Error(
      `远程桌面每次最多粘贴 ${LINUX_DESKTOP_MAX_TEXT_UNITS} 个字符，长内容请上传文件。`,
    );
}

/** An instance is permanently pinned to one deployed virtual desktop generation. */
export function createLinuxDesktopAdapter(options: LinuxDesktopAdapterOptions): DesktopAdapter {
  let enabled = false;
  let generation = 0;
  let pinned: LinuxDesktopSession | undefined;
  let frame: LinuxDesktopFrame | undefined;
  let dimensions: { width: number; height: number; displayId: number } | undefined;
  let inputRunning = false;
  let captureRunning = false;
  let unavailableReason: string | undefined;
  let cleanupUnknown = false;
  const active = new Map<AbortController, { promise: Promise<unknown>; op: string }>();
  const supported = (options.platform ?? process.platform) === 'linux';
  const pathsValid = [options.interpreterPath, options.helperPath, options.manifestPath].every(
    (path) => typeof path === 'string' && isAbsolute(path) && !path.includes('\0'),
  );
  const expected =
    options.expectedSessionId || options.expectedGeneration
      ? { id: options.expectedSessionId!, generation: options.expectedGeneration! }
      : undefined;
  if (!pathsValid || (expected && !validSession(expected)))
    unavailableReason = errorMessages.DESKTOP_UNAVAILABLE;

  function unavailable(reason: string): DesktopStatus {
    return {
      kind: 'virtual',
      available: false,
      authorized: false,
      enabled: false,
      reason,
      width: 0,
      height: 0,
      displays: [],
      ...(pinned ? { session: { ...pinned } } : {}),
      permissions: { screenRecording: 'unknown', accessibility: 'unknown' },
    };
  }
  function disable() {
    enabled = false;
    frame = undefined;
    generation++;
    for (const [controller, operation] of active) if (operation.op !== 'status') controller.abort();
  }
  function poison(code: LinuxDesktopErrorCode) {
    if (code === 'CLEANUP_UNKNOWN') cleanupUnknown = true;
    unavailableReason ??= errorMessages[code];
    disable();
    for (const controller of active.keys()) controller.abort();
  }
  function failure(code: LinuxDesktopErrorCode, fatal = !recoverable.has(code)): never {
    frame = undefined;
    if (fatal) poison(code);
    throw Object.assign(new Error(errorMessages[code]), {
      code,
      cleanupConfirmed: code !== 'CLEANUP_UNKNOWN',
    });
  }
  function requireEnabled() {
    if (unavailableReason) throw new Error(unavailableReason);
    if (!supported) throw new Error('专用虚拟桌面只能在受管 Linux 电脑上运行。');
    if (!enabled) throw new Error('虚拟桌面尚未由用户启用。');
  }
  function checkSession(session: unknown) {
    if (!validSession(session)) failure('DESKTOP_UNAVAILABLE');
    if ((expected && !sameSession(expected, session)) || (pinned && !sameSession(pinned, session)))
      failure('STALE_SESSION');
    return { id: session.id, generation: session.generation };
  }

  async function request(payload: LinuxDesktopRequest, signal?: AbortSignal): Promise<any> {
    if (unavailableReason) throw new Error(unavailableReason);
    if (!supported) throw new Error('专用虚拟桌面只能在受管 Linux 电脑上运行。');
    if (signal?.aborted) throw new Error(errorMessages.CANCELLED);
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > LINUX_DESKTOP_MAX_REQUEST_BYTES) failure('INVALID_REQUEST');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const promise = new Promise<any>((resolveResult, reject) => {
      const child = spawn(
        options.interpreterPath,
        [options.helperPath, '--manifest', options.manifestPath],
        {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
        },
      );
      let stopped: 'CANCELLED' | 'TIMEOUT' | undefined;
      let invalid = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: 'CANCELLED' | 'TIMEOUT') => {
        if (stopped) return;
        stopped = reason;
        // A supervisor must release X input state and reap its descendants itself.
        // SIGKILL here could leave a held mouse button or a still-running xdotool.
        child.kill('SIGTERM');
        cleanupTimer = setTimeout(
          () => poison('CLEANUP_UNKNOWN'),
          Math.max(50, Math.min(15_000, options.cleanupWaitMs ?? 15_000)),
        );
        cleanupTimer.unref();
      };
      const cancel = () => stop('CANCELLED');
      controller.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(
        () => stop('TIMEOUT'),
        Math.max(
          50,
          Math.min(LINUX_DESKTOP_TIMEOUT_MS, options.timeoutMs ?? LINUX_DESKTOP_TIMEOUT_MS),
        ),
      );
      timer.unref();
      child.on('error', () => {
        invalid = true;
      });
      child.stdin.on('error', () => {
        invalid = true;
        stop('CANCELLED');
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > LINUX_DESKTOP_MAX_REPLY_BYTES) {
          invalid = true;
          stop('CANCELLED');
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.once('close', (code, exitSignal) => {
        clearTimeout(timer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        controller.signal.removeEventListener('abort', cancel);
        try {
          if (invalid || exitSignal) failure('CLEANUP_UNKNOWN');
          let reply: any;
          try {
            reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            failure('CLEANUP_UNKNOWN');
          }
          if (!record(reply)) failure('CLEANUP_UNKNOWN');
          if (reply.ok === false) {
            const reported = reply.error?.code;
            if (reply.error?.cleanupConfirmed !== true) failure('CLEANUP_UNKNOWN');
            if (typeof reported !== 'string' || !Object.hasOwn(errorMessages, reported))
              failure('DESKTOP_UNAVAILABLE');
            if (!recoverable.has(reported as LinuxDesktopErrorCode))
              failure(reported as LinuxDesktopErrorCode);
            failure(stopped ?? (reported as LinuxDesktopErrorCode));
          }
          if (reply.ok !== true || code !== 0) failure('CLEANUP_UNKNOWN');
          if (stopped) failure(stopped);
          resolveResult(reply.result);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(errorMessages.DESKTOP_UNAVAILABLE));
        }
      });
      child.stdin.end(input);
      if (signal?.aborted || controller.signal.aborted) stop('CANCELLED');
    });
    active.set(controller, { promise, op: payload.op });
    try {
      return await promise;
    } finally {
      active.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  const adapter: DesktopAdapter = {
    async status() {
      if (unavailableReason) return unavailable(unavailableReason);
      if (!supported) return unavailable('专用虚拟桌面只能在受管 Linux 电脑上运行。');
      const started = generation;
      try {
        const result = await request({ op: 'status' });
        if (started !== generation) return unavailable(errorMessages.CANCELLED);
        if (
          !record(result) ||
          result.kind !== 'virtual' ||
          result.available !== true ||
          result.authorized !== true ||
          result.permissions?.screenRecording !== 'granted' ||
          result.permissions?.accessibility !== 'granted' ||
          !integer(result.width, 1, 1600) ||
          !integer(result.height, 1, 1000) ||
          !integer(result.displayId, 0, 0x7fffffff) ||
          !Array.isArray(result.displays) ||
          result.displays.length !== 1
        )
          failure('DESKTOP_UNAVAILABLE');
        const session = checkSession(result.session);
        const display = result.displays[0];
        if (
          !record(display) ||
          display.id !== result.displayId ||
          display.x !== 0 ||
          display.y !== 0 ||
          display.logicalWidth !== result.width ||
          display.logicalHeight !== result.height ||
          display.pixelWidth !== result.width ||
          display.pixelHeight !== result.height
        )
          failure('DESKTOP_UNAVAILABLE');
        if (
          dimensions &&
          (dimensions.width !== result.width ||
            dimensions.height !== result.height ||
            dimensions.displayId !== result.displayId)
        )
          failure('STALE_SESSION');
        pinned ??= session;
        dimensions ??= { width: result.width, height: result.height, displayId: result.displayId };
        return {
          kind: 'virtual',
          session: { ...pinned },
          available: true,
          authorized: true,
          enabled,
          ...dimensions,
          displays: [
            {
              id: display.id,
              x: display.x,
              y: display.y,
              logicalWidth: display.logicalWidth,
              logicalHeight: display.logicalHeight,
              pixelWidth: display.pixelWidth,
              pixelHeight: display.pixelHeight,
            } as DesktopDisplay,
          ],
          permissions: { screenRecording: 'granted', accessibility: 'granted' },
        };
      } catch (error) {
        return unavailable(
          unavailableReason ??
            (error instanceof Error ? error.message : errorMessages.DESKTOP_UNAVAILABLE),
        );
      }
    },
    async capture({ signal } = {}) {
      requireEnabled();
      if (captureRunning || inputRunning) throw new Error('上一项虚拟桌面操作尚未完成。');
      captureRunning = true;
      frame = undefined;
      const started = generation;
      try {
        if (!pinned && !(await adapter.status()).authorized)
          throw new Error(unavailableReason ?? errorMessages.DESKTOP_UNAVAILABLE);
        requireEnabled();
        if (generation !== started) failure('CANCELLED');
        const result = await request(
          { op: 'capture', enabled: true, session: { ...pinned! } },
          signal,
        );
        requireEnabled();
        if (generation !== started) failure('CANCELLED');
        if (!record(result)) failure('DESKTOP_UNAVAILABLE');
        checkSession(result.session);
        if (
          typeof result.png !== 'string' ||
          result.png.length > LINUX_DESKTOP_MAX_REPLY_BYTES ||
          result.width !== dimensions?.width ||
          result.height !== dimensions?.height ||
          result.displayId !== dimensions?.displayId ||
          typeof result.geometryToken !== 'string' ||
          !result.geometryToken ||
          result.geometryToken.length > 500 ||
          typeof result.capturedAt !== 'string' ||
          !Number.isFinite(Date.parse(result.capturedAt))
        )
          failure('DESKTOP_UNAVAILABLE');
        const png = Buffer.from(result.png, 'base64');
        if (
          png.length < 24 ||
          png.length > LINUX_DESKTOP_MAX_PNG_BYTES ||
          png.toString('base64') !== result.png ||
          !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          png.toString('ascii', 12, 16) !== 'IHDR' ||
          png.readUInt32BE(16) !== result.width ||
          png.readUInt32BE(20) !== result.height
        )
          failure('DESKTOP_UNAVAILABLE');
        frame = {
          displayId: result.displayId,
          geometryToken: result.geometryToken,
          width: result.width,
          height: result.height,
        };
        return { png, width: result.width, height: result.height, capturedAt: result.capturedAt };
      } finally {
        captureRunning = false;
      }
    },
    async execute(input: DesktopInput, { signal } = {}) {
      requireEnabled();
      validateLinuxInput(input);
      if (!frame || !pinned) throw new Error('请先刷新专用虚拟桌面截图，再执行输入。');
      if (inputRunning || captureRunning) throw new Error('上一项虚拟桌面操作尚未完成。');
      if (input.type === 'click' || input.type === 'drag') {
        const inside = (x: number, y: number) => x < frame!.width && y < frame!.height;
        if (!inside(input.x, input.y) || (input.type === 'drag' && !inside(input.toX, input.toY)))
          throw new Error('输入位置超出虚拟桌面截图。');
      }
      inputRunning = true;
      const started = generation;
      try {
        const result = await request(
          { op: 'input', enabled: true, session: { ...pinned }, frame: { ...frame }, input },
          signal,
        );
        requireEnabled();
        if (generation !== started) failure('CANCELLED');
        if (!record(result) || result.ok !== true) failure('DESKTOP_UNAVAILABLE');
        checkSession(result.session);
        if (result.geometryToken !== undefined && result.geometryToken !== frame?.geometryToken)
          failure('STALE_FRAME');
        return { ok: true };
      } finally {
        inputRunning = false;
      }
    },
    setEnabled(value) {
      if (value) {
        if (unavailableReason) throw new Error(unavailableReason);
        enabled = true;
      } else disable();
    },
    async close() {
      disable();
      const pending = [...active.entries()];
      for (const [controller] of pending) controller.abort();
      await Promise.allSettled(pending.map(([, operation]) => operation.promise));
    },
  };
  maintenanceStates.set(adapter, () => ({ cleanupUnknown, activeHelpers: active.size }));
  return adapter;
}

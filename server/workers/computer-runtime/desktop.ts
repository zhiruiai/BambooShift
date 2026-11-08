import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type DesktopPermission = 'granted' | 'denied' | 'unknown';
export interface DesktopDisplay {
  id: number;
  x: number;
  y: number;
  logicalWidth: number;
  logicalHeight: number;
  pixelWidth: number;
  pixelHeight: number;
}
export interface DesktopStatus {
  kind?: 'host' | 'virtual';
  session?: { id: string; generation: string };
  available: boolean;
  authorized: boolean;
  enabled: boolean;
  reason?: string;
  width: number;
  height: number;
  displayId?: number;
  displays: DesktopDisplay[];
  permissions: { screenRecording: DesktopPermission; accessibility: DesktopPermission };
}
export type DesktopInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right'; clickCount?: 1 | 2 }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number; durationMs?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; deltaY: number; deltaX?: number };
export interface DesktopCapture {
  png: Buffer;
  width: number;
  height: number;
  capturedAt: string;
}
export interface DesktopAdapter {
  status(): Promise<DesktopStatus>;
  capture(options?: { signal?: AbortSignal }): Promise<DesktopCapture>;
  execute(input: DesktopInput, options?: { signal?: AbortSignal }): Promise<{ ok: true }>;
  setEnabled(enabled: boolean): void;
  close(): Promise<void>;
}
export interface DesktopAdapterOptions {
  enabled?: boolean;
  helperPath?: string;
  /** Test-only platform selection; production defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Bounded helper deadline, useful for fake-process tests. */
  timeoutMs?: number;
}

export const DEFAULT_DESKTOP_HELPER = fileURLToPath(
  new URL(
    'data/native/OpenBot Desktop Helper.app/Contents/MacOS/OpenBotDesktopHelper',
    // Released bundles retain their layout under runtime/packages.
    new URL(import.meta.url.endsWith('.ts') ? '../../../' : '../../', import.meta.url),
  ),
);
const keys = new Set(
  [
    'Enter',
    'Tab',
    'Escape',
    'Backspace',
    'Delete',
    'ArrowLeft',
    'ArrowRight',
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Space',
    ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ].map((x) => x.toLowerCase()),
);
const modifiers = new Set([
  'controlormeta',
  'meta',
  'command',
  'control',
  'alt',
  'option',
  'shift',
]);
function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate again at the process boundary; the helper independently checks the same limits. */
export function validateDesktopInput(input: unknown): asserts input is DesktopInput {
  if (!record(input)) throw new Error('桌面操作无效。');
  let allowed: string[];
  switch (input.type) {
    case 'click':
      allowed = ['type', 'x', 'y', 'button', 'clickCount'];
      if (
        !numberIn(input.x, 0, 1600) ||
        !numberIn(input.y, 0, 1000) ||
        (input.button !== undefined && !['left', 'right'].includes(input.button)) ||
        (input.clickCount !== undefined && ![1, 2].includes(input.clickCount))
      )
        throw new Error('鼠标位置、按键或点击次数无效。');
      break;
    case 'drag':
      allowed = ['type', 'x', 'y', 'toX', 'toY', 'durationMs'];
      if (
        ![input.x, input.toX].every((x) => numberIn(x, 0, 1600)) ||
        ![input.y, input.toY].every((y) => numberIn(y, 0, 1000)) ||
        (input.durationMs !== undefined && !numberIn(input.durationMs, 100, 2000))
      )
        throw new Error('拖动位置或时长无效（100–2000 毫秒）。');
      break;
    case 'type':
      allowed = ['type', 'text'];
      if (
        typeof input.text !== 'string' ||
        !input.text.length ||
        input.text.length > 20_000 ||
        input.text.includes('\0')
      )
        throw new Error('输入文字必须为 1–20000 个字符，且不含空字符。');
      break;
    case 'key': {
      allowed = ['type', 'key'];
      if (typeof input.key !== 'string' || input.key.length > 100)
        throw new Error('按键名称无效。');
      const parts = input.key.toLowerCase().split('+'),
        key = parts.pop()!;
      if (
        parts.length > 4 ||
        !parts.every((p) => modifiers.has(p)) ||
        (!keys.has(key) && !/^[a-z0-9=\-\][;'\\,/.`]$/.test(key))
      )
        throw new Error('不支持此按键或组合键。');
      break;
    }
    case 'scroll':
      allowed = ['type', 'deltaY', 'deltaX'];
      if (
        !numberIn(input.deltaY, -4000, 4000) ||
        (input.deltaX !== undefined && !numberIn(input.deltaX, -4000, 4000))
      )
        throw new Error('滚动距离必须在 ±4000 像素内。');
      break;
    default:
      throw new Error('不支持此桌面操作。');
  }
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error('桌面操作包含未知字段。');
}

interface Frame {
  displayId: number;
  geometryToken: string;
  width: number;
  height: number;
}
const unknownPermissions = () => ({
  screenRecording: 'unknown' as const,
  accessibility: 'unknown' as const,
});
function unavailable(enabled: boolean, reason: string): DesktopStatus {
  return {
    available: false,
    authorized: false,
    enabled,
    reason,
    width: 0,
    height: 0,
    displays: [],
    permissions: unknownPermissions(),
  };
}

/** One request per process: no persistent input daemon and no permission prompts. */
export function createDesktopAdapter(options: DesktopAdapterOptions = {}): DesktopAdapter {
  const helperPath = options.helperPath ?? DEFAULT_DESKTOP_HELPER;
  const platform = options.platform ?? process.platform;
  let enabled = options.enabled ?? false;
  let frame: Frame | undefined;
  let generation = 0;
  let inputRunning = false;
  const active = new Map<AbortController, { promise: Promise<unknown>; mutation: boolean }>();

  async function request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (platform !== 'darwin') throw new Error('整机桌面目前仅支持 macOS 14 或更新版本。');
    if (signal?.aborted) throw new Error('桌面操作已取消。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const promise = runHelper(
      helperPath,
      payload,
      controller.signal,
      options.timeoutMs ??
        (payload.op === 'capture' ? 15_000 : payload.op === 'status' ? 5_000 : 10_000),
    );
    active.set(controller, { promise, mutation: payload.op !== 'status' });
    try {
      return await promise;
    } finally {
      active.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }
  function requireEnabled() {
    if (!enabled) throw new Error('整机控制尚未由用户启用。');
  }
  function disable() {
    enabled = false;
    frame = undefined;
    generation++;
    for (const [controller, operation] of active) if (operation.mutation) controller.abort();
  }
  const adapter: DesktopAdapter = {
    async status() {
      if (platform !== 'darwin')
        return unavailable(enabled, '整机桌面目前仅支持 macOS 14 或更新版本。');
      const started = generation;
      try {
        await access(helperPath, constants.X_OK);
      } catch {
        return unavailable(enabled, '桌面助手尚未构建，请运行 node scripts/build-desktop.mjs。');
      }
      if (started !== generation) return unavailable(enabled, '桌面状态读取已取消。');
      try {
        const result = await request({ op: 'status' });
        const permission = (value: unknown): DesktopPermission =>
          ['granted', 'denied', 'unknown'].includes(String(value))
            ? (value as DesktopPermission)
            : 'unknown';
        if (
          !record(result) ||
          typeof result.available !== 'boolean' ||
          !numberIn(result.width, 0, 1600) ||
          !numberIn(result.height, 0, 1000) ||
          (result.available && (!result.width || !result.height)) ||
          !Array.isArray(result.displays)
        )
          throw new Error('桌面助手状态无效。');
        const permissions = {
          screenRecording: permission(result.permissions?.screenRecording),
          accessibility: permission(result.permissions?.accessibility),
        };
        return {
          available: result.available,
          authorized:
            result.available &&
            permissions.screenRecording === 'granted' &&
            permissions.accessibility === 'granted',
          enabled,
          width: result.width,
          height: result.height,
          displayId: result.displayId,
          displays: result.displays.filter(
            (d: unknown) =>
              record(d) &&
              ['id', 'x', 'y', 'logicalWidth', 'logicalHeight', 'pixelWidth', 'pixelHeight'].every(
                (k) => Number.isFinite(d[k]),
              ),
          ),
          permissions,
          reason:
            typeof result.reason === 'string'
              ? result.reason.slice(0, 1000) || undefined
              : undefined,
        };
      } catch (error) {
        return unavailable(
          enabled,
          error instanceof Error ? error.message : '无法读取桌面助手状态。',
        );
      }
    },
    async capture({ signal } = {}) {
      requireEnabled();
      const started = generation;
      const result = await request({ op: 'capture', enabled: true }, signal);
      requireEnabled();
      if (started !== generation) throw new Error('桌面连接已变更，请重试。');
      if (
        !record(result) ||
        typeof result.png !== 'string' ||
        result.png.length > 12 * 1024 * 1024 ||
        !numberIn(result.width, 1, 1600) ||
        !numberIn(result.height, 1, 1000) ||
        !Number.isInteger(result.displayId) ||
        typeof result.geometryToken !== 'string' ||
        result.geometryToken.length > 500 ||
        typeof result.capturedAt !== 'string' ||
        !Number.isFinite(Date.parse(result.capturedAt))
      )
        throw new Error('桌面截图数据无效。');
      const png = Buffer.from(result.png, 'base64');
      if (
        png.length < 24 ||
        png.length > 8 * 1024 * 1024 ||
        !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.toString('ascii', 12, 16) !== 'IHDR' ||
        png.readUInt32BE(16) !== result.width ||
        png.readUInt32BE(20) !== result.height
      )
        throw new Error('桌面截图格式或尺寸无效。');
      frame = {
        displayId: result.displayId,
        geometryToken: result.geometryToken,
        width: result.width,
        height: result.height,
      };
      return { png, width: result.width, height: result.height, capturedAt: result.capturedAt };
    },
    async execute(input, { signal } = {}) {
      requireEnabled();
      validateDesktopInput(input);
      if (!frame) throw new Error('请先刷新主屏截图，再操作桌面。');
      if (inputRunning) throw new Error('上一项桌面输入尚未完成，请稍后重试。');
      if (input.type === 'click' || input.type === 'drag') {
        const valid = (x: number, y: number) => x < frame!.width && y < frame!.height;
        if (!valid(input.x, input.y) || (input.type === 'drag' && !valid(input.toX, input.toY)))
          throw new Error('点击位置超出主屏截图。');
      }
      inputRunning = true;
      const started = generation;
      try {
        const result = await request({ op: 'input', enabled: true, input, frame }, signal);
        if (started !== generation || !enabled) throw new Error('桌面连接已变更，操作已取消。');
        if (!record(result) || result.ok !== true) throw new Error('桌面助手未确认操作完成。');
        return { ok: true };
      } finally {
        inputRunning = false;
      }
    },
    setEnabled(value) {
      if (value) {
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
  return adapter;
}

function runHelper(
  helperPath: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('桌面操作已取消。'));
      return;
    }
    // Deliberately omit API tokens and model settings from the native process environment.
    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: 'en_US.UTF-8',
      },
    });
    let error: Error | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error) => {
      if (error) return;
      error = reason;
      // Graceful TERM lets Swift release held inputs; KILL is a bounded fallback.
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
    };
    const cancel = () => stop(new Error('桌面操作已取消。'));
    const timer = setTimeout(
      () => stop(new Error('桌面助手响应超时。')),
      Math.max(50, Math.min(30_000, timeoutMs)),
    );
    signal.addEventListener('abort', cancel, { once: true });
    child.on('error', () => {
      error ??= new Error('无法启动桌面助手，请先完成构建。');
    });
    child.stdin.on('error', () => stop(new Error('桌面助手通信中断。')));
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 12 * 1024 * 1024) stop(new Error('桌面助手输出超过大小限制。'));
      else chunks.push(chunk);
    });
    // Drain stderr without retaining user data or native debug output.
    child.stderr.resume();
    child.once('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
      if (error) {
        reject(error);
        return;
      }
      if (code !== 0) {
        reject(new Error('桌面助手意外退出。'));
        return;
      }
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (reply?.ok !== true)
          throw new Error(
            typeof reply?.error?.message === 'string'
              ? reply.error.message.slice(0, 1000)
              : '桌面操作失败。',
          );
        resolve(reply.result);
      } catch (failure) {
        reject(failure instanceof Error ? failure : new Error('桌面助手返回无效响应。'));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

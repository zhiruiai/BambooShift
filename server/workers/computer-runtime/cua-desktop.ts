import { validateDesktopInput, type DesktopAdapter, type DesktopStatus } from './desktop.js';
import {
  openCuaConnection,
  type CuaConnection,
  type CuaConnectionFactory,
  type CuaEndpoint,
} from './cua-connection.js';
import {
  cuaActions,
  cuaCapture,
  cuaGeometry,
  cuaImageSize,
  cuaInputOutcome,
  sameCuaGeometry,
  type CuaFrame,
} from './cua-desktop-protocol.js';

export interface CuaDesktopOptions extends CuaEndpoint {
  /** Constructor-only test seams, never populated from an agent request. */
  connectionFactory?: CuaConnectionFactory;
  platform?: NodeJS.Platform;
}

/** Host desktop through the official embedded driver; Rust remains the approval authority. */
export function createCuaDesktopAdapter(options: CuaDesktopOptions): DesktopAdapter {
  let enabled = false;
  let generation = 0;
  let frame: CuaFrame | undefined;
  let busy = false;
  let closed = false;
  let cleanupUnknown = false;
  let connection: Promise<CuaConnection> | undefined;
  const active = new Map<AbortController, { promise: Promise<unknown>; sensitive: boolean }>();
  const supported = (options.platform ?? process.platform) === 'darwin';
  const unknownMessage = '无法确认桌面输入已停止，当前连接已停用。请重启本地工作空间后检查画面。';
  const unknownError = () =>
    Object.assign(new Error(unknownMessage), {
      code: 'OPERATION_CLEANUP_UNKNOWN',
      cleanupConfirmed: false,
    });
  function disable() {
    enabled = false;
    frame = undefined;
    generation++;
    for (const [controller, operation] of active) if (operation.sensitive) controller.abort();
  }
  function requireEnabled() {
    if (cleanupUnknown) throw unknownError();
    if (closed) throw new Error('桌面驱动连接已结束，请重启本地工作空间。');
    if (!supported) throw new Error('当前桌面驱动集成仅支持 macOS。');
    if (!enabled) throw new Error('整机控制尚未由用户启用。');
  }
  function poison(): never {
    cleanupUnknown = true;
    disable();
    throw unknownError();
  }
  async function run<T>(
    sensitive: boolean,
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const promise = fn(controller.signal);
    active.set(controller, { promise, sensitive });
    try {
      return await promise;
    } finally {
      active.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function getConnection(signal: AbortSignal) {
    signal.throwIfAborted();
    if (closed || cleanupUnknown) throw new Error('桌面驱动连接已停用。');
    // Pin the implicit Cua session for this adapter's lifetime. Never reconnect/replay.
    connection ??= (options.connectionFactory ?? openCuaConnection)(options, signal);
    const client = await connection;
    signal.throwIfAborted();
    return client;
  }
  async function state(signal: AbortSignal) {
    const client = await getConnection(signal);
    const permissions = await client.call(
      'check_permissions',
      {
        prompt: false,
        probe_direct_capture: false,
      },
      signal,
    );
    const data = permissions.structuredContent;
    if (
      permissions.isError ||
      !data ||
      typeof data.accessibility !== 'boolean' ||
      typeof data.screen_recording !== 'boolean'
    )
      throw new Error('无法读取桌面权限状态。');
    const geometry = cuaGeometry(await client.call('get_screen_size', {}, signal));
    return {
      client,
      geometry,
      permissions: {
        accessibility: data.accessibility ? ('granted' as const) : ('denied' as const),
        screenRecording: data.screen_recording ? ('granted' as const) : ('denied' as const),
      },
    };
  }
  function requireAuthorized(permissions: DesktopStatus['permissions']) {
    if (permissions.accessibility !== 'granted' || permissions.screenRecording !== 'granted') {
      frame = undefined;
      throw new Error('请在系统设置中允许桌面应用使用屏幕录制和辅助功能。');
    }
  }
  function current(started: number, signal: AbortSignal) {
    signal.throwIfAborted();
    requireEnabled();
    if (started !== generation) throw new Error('桌面连接已变更，请重新截图。');
  }
  function unavailable(reason: string): DesktopStatus {
    return {
      kind: 'host',
      available: false,
      authorized: false,
      enabled,
      width: 0,
      height: 0,
      displays: [],
      reason,
      permissions: { accessibility: 'unknown', screenRecording: 'unknown' },
    };
  }
  const adapter: DesktopAdapter = {
    async status() {
      if (!supported) return unavailable('当前桌面驱动集成仅支持 macOS。');
      if (cleanupUnknown || closed)
        return unavailable(cleanupUnknown ? unknownMessage : '桌面连接已结束。');
      const started = generation;
      try {
        return await run(false, undefined, async (signal) => {
          const { geometry, permissions } = await state(signal);
          if (started !== generation) return unavailable('桌面状态读取已取消。');
          const authorized = Object.values(permissions).every((value) => value === 'granted');
          return {
            kind: 'host',
            available: true,
            authorized,
            enabled,
            ...cuaImageSize(geometry),
            displays: [],
            permissions,
            ...(authorized ? {} : { reason: '请在系统设置中允许屏幕录制和辅助功能。' }),
          };
        });
      } catch {
        return unavailable('桌面驱动尚未就绪，请检查桌面应用。');
      }
    },
    async capture({ signal } = {}) {
      requireEnabled();
      if (busy) throw new Error('上一项桌面操作尚未完成。');
      busy = true;
      frame = undefined;
      const started = generation;
      try {
        return await run(true, signal, async (signal) => {
          const { client, geometry, permissions } = await state(signal);
          current(started, signal);
          requireAuthorized(permissions);
          const size = cuaImageSize(geometry);
          const result = await client.call(
            'get_desktop_state',
            {
              max_image_dimension: Math.max(size.width, size.height),
            },
            signal,
          );
          current(started, signal);
          const parsed = cuaCapture(result, geometry);
          const after = cuaGeometry(await client.call('get_screen_size', {}, signal));
          current(started, signal);
          if (!sameCuaGeometry(geometry, after)) throw new Error('主屏幕尺寸已变化，请重新截图。');
          frame = parsed.frame;
          return parsed.capture;
        });
      } finally {
        busy = false;
      }
    },
    async execute(input, { signal } = {}) {
      requireEnabled();
      validateDesktopInput(input);
      if (busy) throw new Error('上一项桌面操作尚未完成。');
      const observed = frame;
      if (!observed || Date.now() - observed.capturedAt > 60_000)
        throw new Error('请先刷新主屏截图，再操作桌面。');
      if (input.type === 'click' || input.type === 'drag') {
        const valid = (x: number, y: number) => x < observed.imageWidth && y < observed.imageHeight;
        if (!valid(input.x, input.y) || (input.type === 'drag' && !valid(input.toX, input.toY)))
          throw new Error('点击位置超出主屏截图。');
      }
      const actions = cuaActions(input, observed);
      busy = true;
      const started = generation;
      try {
        return await run(true, signal, async (signal) => {
          const { client, geometry, permissions } = await state(signal);
          current(started, signal);
          requireAuthorized(permissions);
          frame = undefined;
          if (!sameCuaGeometry(observed, geometry))
            throw new Error('主屏幕尺寸已变化，请重新截图。');
          for (const action of actions) {
            current(started, signal);
            let result;
            try {
              result = await client.call(action.name, action.args, signal);
            } catch {
              return poison();
            }
            const outcome = cuaInputOutcome(result);
            if (outcome === 'unknown') return poison();
            if (outcome === 'refused') throw new Error('桌面驱动拒绝了操作，请刷新画面后重试。');
            if (outcome === 'incomplete')
              throw new Error('桌面操作未全部完成，请先检查画面，勿重复发送。');
            // Even a cancellation racing the response is not proof that the host released input.
            if (signal.aborted || started !== generation || !enabled) return poison();
          }
          return { ok: true };
        });
      } finally {
        busy = false;
      }
    },
    setEnabled(value) {
      if (!value) return disable();
      if (cleanupUnknown) throw unknownError();
      if (closed) throw new Error('桌面连接已结束，请重启本地工作空间。');
      enabled = true;
    },
    async close() {
      disable();
      closed = true;
      const pending = [...active];
      for (const [controller] of pending) controller.abort();
      await Promise.allSettled(pending.map(([, operation]) => operation.promise));
      const client = await connection?.catch(() => undefined);
      await client?.close();
      // Closing a proxy does not prove that a delivered daemon input was cancelled.
      if (cleanupUnknown) throw unknownError();
    },
  };
  return adapter;
}

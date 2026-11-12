import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createCuaDesktopAdapter } from '../cua-desktop.ts';
import type { CuaResult } from '../cua-connection.ts';

const png = await sharp({
  create: {
    width: 1600,
    height: 900,
    channels: 3,
    background: '#eef0f2',
  },
})
  .png()
  .toBuffer();
const inputNames = new Set(['click', 'drag', 'scroll', 'type_text', 'press_key']);

function fixture() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const state = {
    geometry: { width: 1920, height: 1080, scale_factor: 2 },
    authorized: true,
    connections: 0,
    closed: false,
    inputResult: {
      structuredContent: { effect: 'unverifiable', route: 'global_input' },
    } as CuaResult,
    imageResult: undefined as CuaResult | undefined,
    intercept: undefined as
      ((name: string, signal: AbortSignal) => Promise<CuaResult> | undefined) | undefined,
  };
  const adapter = createCuaDesktopAdapter({
    executablePath: '/test/cua-driver',
    socketPath: '/test/driver.sock',
    platform: 'darwin',
    connectionFactory: async () => {
      state.connections++;
      return {
        async call(name, args, signal) {
          signal.throwIfAborted();
          calls.push({ name, args });
          const intercepted = state.intercept?.(name, signal);
          if (intercepted) return intercepted;
          if (name === 'check_permissions')
            return {
              structuredContent: {
                accessibility: state.authorized,
                screen_recording: state.authorized,
              },
            };
          if (name === 'get_screen_size') return { structuredContent: { ...state.geometry } };
          if (name === 'get_desktop_state')
            return (
              state.imageResult ?? {
                structuredContent: {
                  platform: 'macos',
                  display: 'primary',
                  screen_width: state.geometry.width,
                  screen_height: state.geometry.height,
                  scale_factor: state.geometry.scale_factor,
                  screenshot_width: 1600,
                  screenshot_height: 900,
                  capture_id: `capture-${calls.length}`,
                },
                content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
              }
            );
          if (inputNames.has(name)) return state.inputResult;
          throw new Error(`Unexpected call: ${name}`);
        },
        async close() {
          state.closed = true;
        },
      };
    },
  });
  const inputs = () => calls.filter(({ name }) => inputNames.has(name));
  return { adapter, calls, state, inputs };
}

test('Cua status never captures or prompts; input needs explicit enable and a current screenshot', async () => {
  const f = fixture();
  try {
    const status = await f.adapter.status();
    assert.equal(status.available, true);
    assert.equal(status.authorized, true);
    assert.equal(status.enabled, false);
    assert.equal(status.width, 1600);
    assert.equal(status.height, 900);
    assert.deepEqual(f.calls.slice(), [
      { name: 'check_permissions', args: { prompt: false, probe_direct_capture: false } },
      { name: 'get_screen_size', args: {} },
    ]);
    await assert.rejects(f.adapter.capture(), /尚未/);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /尚未/);
    f.adapter.setEnabled(true);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
    const capture = await f.adapter.capture();
    assert.deepEqual(capture.png, png);
    assert.equal(
      f.calls.find(({ name }) => name === 'get_desktop_state')?.args.max_image_dimension,
      1600,
    );
    const captureId = `capture-${f.calls.findIndex(({ name }) => name === 'get_desktop_state') + 1}`;
    assert.deepEqual(
      await f.adapter.execute({ type: 'click', x: 800, y: 450, button: 'right', clickCount: 2 }),
      { ok: true },
    );
    assert.deepEqual(f.inputs(), [
      {
        name: 'click',
        args: {
          target: { kind: 'desktop', display_id: 'primary' },
          x: 800,
          y: 450,
          capture_id: captureId,
          delivery_mode: 'foreground',
          button: 'right',
          count: 2,
        },
      },
    ]);
    await assert.rejects(f.adapter.execute({ type: 'click', x: 2, y: 2 }), /截图/);
    assert.equal(
      f.state.connections,
      1,
      'all capture/input calls share one implicit driver session',
    );
  } finally {
    await f.adapter.close();
  }
  assert.equal(f.state.closed, true);
});

test('Cua maps bounded Retina frames, wheel notches and keyboard semantics without sending arbitrary tools', async () => {
  const f = fixture();
  try {
    f.adapter.setEnabled(true);
    await f.adapter.capture();
    await f.adapter.execute({ type: 'drag', x: 100, y: 200, toX: 300, toY: 400, durationMs: 600 });
    assert.deepEqual(f.inputs()[0], {
      name: 'drag',
      args: {
        target: { kind: 'desktop', display_id: 'primary' },
        from_x: 240,
        from_y: 480,
        to_x: 720,
        to_y: 960,
        duration_ms: 600,
      },
    });
    await f.adapter.capture();
    await f.adapter.execute({ type: 'scroll', deltaY: 240, deltaX: -120 });
    assert.deepEqual(
      f
        .inputs()
        .slice(1)
        .map(({ args }) => args),
      [
        {
          target: { kind: 'desktop', display_id: 'primary' },
          x: 1920,
          y: 1080,
          direction: 'down',
          by: 'line',
          amount: 2,
        },
        {
          target: { kind: 'desktop', display_id: 'primary' },
          x: 1920,
          y: 1080,
          direction: 'left',
          by: 'line',
          amount: 1,
        },
      ],
    );
    await f.adapter.capture();
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Meta+Command+A' }), /重复/);
    await f.adapter.execute({ type: 'key', key: 'ControlOrMeta+Shift+Delete' });
    assert.deepEqual(f.inputs().at(-1)?.args, {
      target: { kind: 'desktop', display_id: 'primary' },
      key: 'forward_delete',
      modifiers: ['cmd', 'shift'],
    });
    await f.adapter.capture();
    await assert.rejects(f.adapter.execute({ type: 'type', text: '\uD800' }), /Unicode/);
    await f.adapter.execute({ type: 'type', text: '测试 🙂' });
    assert.equal(f.inputs().at(-1)?.args.text, '测试 🙂');
  } finally {
    await f.adapter.close();
  }
});

test('Cua rejects revoked permissions, changed geometry and out-of-frame input before dispatch', async () => {
  const f = fixture();
  try {
    f.adapter.setEnabled(true);
    await f.adapter.capture();
    await assert.rejects(f.adapter.execute({ type: 'click', x: 1600, y: 10 }), /超出/);
    f.state.geometry.scale_factor = 1;
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /尺寸/);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
    await f.adapter.capture();
    f.state.authorized = false;
    await assert.rejects(f.adapter.execute({ type: 'type', text: 'no input' }), /系统设置/);
    assert.equal((await f.adapter.status()).authorized, false);
    const previousCaptures = f.calls.filter(({ name }) => name === 'get_desktop_state').length;
    await assert.rejects(f.adapter.capture(), /系统设置/);
    assert.equal(
      f.calls.filter(({ name }) => name === 'get_desktop_state').length,
      previousCaptures,
    );
    assert.deepEqual(f.inputs(), []);
  } finally {
    await f.adapter.close();
  }
});

test('Cua validates PNG geometry and fails closed for unverified platform support', async () => {
  const f = fixture();
  try {
    f.adapter.setEnabled(true);
    f.state.imageResult = {
      structuredContent: {
        platform: 'macos',
        display: 'primary',
        screen_width: 1920,
        screen_height: 1080,
        scale_factor: 2,
        screenshot_width: 100,
        screenshot_height: 100,
        capture_id: 'mismatched',
      },
      content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
    };
    await assert.rejects(f.adapter.capture(), /格式或尺寸/);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
    const unsupported = createCuaDesktopAdapter({
      executablePath: '/missing',
      socketPath: '/missing',
      platform: 'linux',
      connectionFactory: async () => {
        throw Error('must not connect');
      },
    });
    assert.equal((await unsupported.status()).available, false);
    await unsupported.close();
  } finally {
    await f.adapter.close();
  }
});

test('Cua cancellation after dispatch poisons the executor and never treats proxy close as native cleanup', async () => {
  const f = fixture();
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  f.adapter.setEnabled(true);
  await f.adapter.capture();
  f.state.intercept = (name, signal) =>
    name === 'drag'
      ? new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('proxy request cancelled')), {
            once: true,
          });
          dispatched();
        })
      : undefined;
  const pending = f.adapter.execute({ type: 'drag', x: 10, y: 10, toX: 20, toY: 20 });
  await started;
  f.adapter.setEnabled(false);
  const unknown = (error: any) =>
    error.cleanupConfirmed === false && error.code === 'OPERATION_CLEANUP_UNKNOWN';
  await assert.rejects(pending, unknown);
  assert.equal((await f.adapter.status()).available, false);
  assert.throws(() => f.adapter.setEnabled(true), unknown);
  await assert.rejects(f.adapter.close(), unknown);
  assert.equal(f.state.closed, true);
  assert.equal(f.inputs().length, 1, 'no cancellation replay or duplicate input');
});

test('Cua cancellation before dispatch or during capture sends no input and permits explicit re-enable', async () => {
  const f = fixture();
  try {
    f.adapter.setEnabled(true);
    await f.adapter.capture();
    await assert.rejects(
      f.adapter.execute({ type: 'key', key: 'Enter' }, { signal: AbortSignal.abort() }),
    );
    assert.deepEqual(f.inputs(), []);
    let started!: () => void;
    const pendingCapture = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.state.intercept = (name, signal) =>
      name === 'get_desktop_state'
        ? new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('capture cancelled')), {
              once: true,
            });
            started();
          })
        : undefined;
    const pending = f.adapter.capture();
    await pendingCapture;
    f.adapter.setEnabled(false);
    await assert.rejects(pending, /cancelled/);
    f.state.intercept = undefined;
    f.adapter.setEnabled(true);
    await f.adapter.capture();
    await f.adapter.execute({ type: 'key', key: 'Enter' });
    assert.equal(f.inputs().length, 1);
  } finally {
    await f.adapter.close();
  }
});

test('Cua refusals and partial effects require observation and never replay delivered input', async () => {
  const f = fixture();
  try {
    f.adapter.setEnabled(true);
    await f.adapter.capture();
    f.state.inputResult = {
      isError: true,
      structuredContent: { effect: 'refused', error: { code: 'stale_capture' } },
    };
    await assert.rejects(f.adapter.execute({ type: 'click', x: 10, y: 10 }), /拒绝/);
    assert.equal((await f.adapter.status()).available, true);
    await f.adapter.capture();
    f.state.inputResult = {
      structuredContent: { effect: 'partial', delivery: { delivered_count: 1 } },
    };
    await assert.rejects(f.adapter.execute({ type: 'type', text: 'partial' }), /未全部完成/);
    assert.equal(f.inputs().length, 2);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
  } finally {
    await f.adapter.close();
  }
});

test('Cua malformed action result blocks future work instead of reporting false success', async () => {
  const f = fixture();
  f.adapter.setEnabled(true);
  await f.adapter.capture();
  f.state.inputResult = { content: [{ type: 'text' }] };
  await assert.rejects(
    f.adapter.execute({ type: 'key', key: 'Enter' }),
    (error: any) => error.cleanupConfirmed === false,
  );
  await assert.rejects(f.adapter.close(), (error: any) => error.cleanupConfirmed === false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalComputer } from '../../computer-worker/index.js';
import type { DesktopAdapter } from '../desktop.js';

for (const source of ['agent', 'takeover'] as const) {
  test(`${source} desktop input propagates cancellation and waits for release`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openbot-input-cancel-'));
    let enabled = false;
    let released = false;
    let signalObserved = false;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const desktop: DesktopAdapter = {
      async status() {
        return {
          available: true,
          authorized: true,
          enabled,
          width: 1440,
          height: 900,
          displays: [],
          permissions: { screenRecording: 'granted', accessibility: 'granted' },
        };
      },
      async capture() {
        throw new Error('This input-only test does not capture a screen.');
      },
      async execute(_input, options) {
        assert.ok(options?.signal, 'The controller must pass its cancellation signal.');
        signalObserved = true;
        started();
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error('Cancellation was not delivered.')),
            1500,
          );
          const stop = () => {
            clearTimeout(deadline);
            setTimeout(() => {
              released = true;
              resolve();
            }, 20);
          };
          options.signal!.addEventListener('abort', stop, { once: true });
          if (options.signal!.aborted) stop();
        });
        throw new Error('桌面输入已取消并释放。');
      },
      setEnabled(value) {
        enabled = value;
      },
      async close() {
        enabled = false;
      },
    };
    const computer = new LocalComputer(join(dir, 'workspace'), undefined, {
      desktopAdapter: desktop,
    });
    try {
      await computer.setSurface('desktop', true);
      const abort = new AbortController();
      const lease = source === 'takeover' ? await computer.startTakeover() : undefined;
      const operation =
        source === 'agent'
          ? computer.execute(
              { type: 'desktop_type', text: '取消中的输入' },
              { signal: abort.signal },
            )
          : computer.takeoverInput(
              { type: 'type', text: '取消中的输入', leaseId: lease!.leaseId },
              { signal: abort.signal },
            );
      const rejected = assert.rejects(operation, /已取消并释放/);
      await entered;
      abort.abort();
      assert.equal(released, false);
      await rejected;
      assert.equal(signalObserved, true);
      assert.equal(released, true);
    } finally {
      await computer.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

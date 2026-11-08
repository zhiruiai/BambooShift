import test from 'node:test';

import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import sharp from 'sharp';

import type { DesktopAdapter, DesktopInput } from '../desktop.js';

import { LocalComputer } from '../../computer-worker/index.js';

class FakeDesktop implements DesktopAdapter {
  enabled = false;
  authorized = true;
  captures = 0;
  inputs: DesktopInput[] = [];
  beforeExecute?: () => Promise<void>;
  async status(): ReturnType<DesktopAdapter['status']> {
    return {
      available: true,
      authorized: this.authorized,
      enabled: this.enabled,
      width: 1200,
      height: 750,
      reason: this.authorized ? undefined : '缺少屏幕录制与辅助功能权限',
      permissions: {
        screenRecording: this.authorized ? 'granted' : 'denied',
        accessibility: this.authorized ? 'granted' : 'denied',
      },
      displays: [],
    };
  }
  async capture() {
    assert.equal(this.enabled && this.authorized, true);
    this.captures++;
    return {
      png: await sharp({ create: { width: 1200, height: 750, channels: 3, background: '#445566' } })
        .png()
        .toBuffer(),
      width: 1200,
      height: 750,
      capturedAt: new Date().toISOString(),
    };
  }
  async execute(input: DesktopInput): Promise<{ ok: true }> {
    assert.equal(this.enabled && this.authorized, true);
    await this.beforeExecute?.();
    this.inputs.push(input);
    return { ok: true };
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }
  async close() {
    this.enabled = false;
  }
}

test('desktop requires explicit enablement, returns actual dimensions and shares takeover privacy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-desktop-local-'));
  const adapter = new FakeDesktop();
  let now = Date.now();
  const computer = new LocalComputer(join(dir, 'workspace'), undefined, {
    desktopAdapter: adapter,
    now: () => now,
    ttlMs: 1000,
  });
  try {
    const initial = await computer.refreshStatus();
    assert.equal(initial.surface, 'browser');
    assert.equal(adapter.enabled, false);
    assert.equal(adapter.captures, 0);
    await assert.rejects(computer.screenshot(), /尚未打开/);
    assert.equal(adapter.captures, 0);
    await assert.rejects(computer.execute({ type: 'desktop_key', key: 'Meta+Space' }), /模式/);
    await assert.rejects(computer.setSurface('desktop'), /确认/);
    adapter.authorized = false;
    await assert.rejects(computer.setSurface('desktop', true), /权限/);
    assert.equal(computer.status().surface, 'browser');
    adapter.authorized = true;
    await computer.setSurface('desktop', true);
    assert.equal(adapter.captures, 0, 'enabling never captures');
    const screenshot = (await computer.execute({ type: 'desktop_screenshot' })) as any;
    assert.equal(screenshot.width, 1200);
    assert.equal(screenshot.height, 750);
    const lease = await computer.startTakeover();
    assert.equal(lease.width, 1200);
    assert.equal(lease.height, 750);
    assert.equal(lease.surface, 'desktop');
    await assert.rejects(computer.screenshot({ forAgent: true }), /接管/);
    await assert.rejects(computer.execute({ type: 'desktop_type', text: 'private' }), /接管/);
    await computer.screenshot({ leaseId: lease.leaseId });
    for (const input of [
      { type: 'click', x: 1199, y: 749, button: 'right', clickCount: 2 },
      { type: 'key', key: 'ControlOrMeta+V' },
      { type: 'scroll', deltaY: 40, deltaX: 12 },
      { type: 'drag', x: 100, y: 100, toX: 500, toY: 400, durationMs: 500 },
    ])
      await computer.takeoverInput({ leaseId: lease.leaseId, ...input });
    assert.equal((adapter.inputs[0] as any).button, 'right');
    assert.equal((adapter.inputs[0] as any).clickCount, 2);
    assert.equal((adapter.inputs[3] as any).toX, 500);
    await assert.rejects(
      computer.takeoverInput({ leaseId: lease.leaseId, type: 'click', x: 1300, y: 10 }),
      /超出/,
    );
    await assert.rejects(
      computer.takeoverInput({
        leaseId: lease.leaseId,
        type: 'navigate',
        url: 'https://example.com',
      }),
      /整机/,
    );
    now += 1001;
    await assert.rejects(
      computer.takeoverInput({ leaseId: lease.leaseId, type: 'key', key: 'Enter' }),
      /过期/,
    );
    await computer.setSurface('browser', true);
    assert.equal(adapter.enabled, false);
    assert.equal(computer.takeoverStatus().active, false);
    await computer.close();
    await computer.setSurface('desktop', true);
    assert.equal(adapter.enabled, true, 'reconnect can re-enable adapter after close');
  } finally {
    await computer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

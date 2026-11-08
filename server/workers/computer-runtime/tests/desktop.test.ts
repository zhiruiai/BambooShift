import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopAdapter, validateDesktopInput } from '../desktop.ts';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
async function fakeHelper(
  mode: 'normal' | 'hold' | 'ignore' | 'denied' | 'malformed' | 'headless' = 'normal',
  timeoutMs = 5000,
) {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-desktop-test-'));
  const path = join(dir, 'fake-helper');
  const log = join(dir, 'events'),
    pid = join(dir, 'pid'),
    release = join(dir, 'released');
  const script = `#!${process.execPath}
const fs = require('node:fs');
let raw = '';
process.stdin.on('data', data => raw += data);
process.stdin.on('end', () => {
  const request = JSON.parse(raw); const mode = ${JSON.stringify(mode)};
  fs.appendFileSync(${JSON.stringify(log)}, request.op + '\\n');
  const respond = result => process.stdout.write(JSON.stringify({ok:true,result}));
  if (request.op === 'status') return respond({available:mode!=='headless',authorized:mode!=='denied',width:mode==='headless'?0:1,height:mode==='headless'?0:1,displayId:1,displays:[{id:1,x:0,y:0,logicalWidth:1,logicalHeight:1,pixelWidth:1,pixelHeight:1}],permissions:{screenRecording:mode==='denied'?'denied':'granted',accessibility:'granted'}});
  if (mode === 'denied') return process.stdout.write(JSON.stringify({ok:false,error:{code:'PERMISSION_REQUIRED',message:'permission denied'}}));
  if (request.op === 'capture') return respond({png:${JSON.stringify(png)},width:mode==='malformed'?2:1,height:1,capturedAt:new Date().toISOString(),displayId:1,geometryToken:'fake-only'});
  if (mode === 'hold' || mode === 'ignore') {
    process.on('SIGTERM', () => {if(mode==='hold') {fs.writeFileSync(${JSON.stringify(release)},'released'); process.exit(0);}});
    fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
    setInterval(() => {}, 1000); return;
  }
  if (!request.enabled || request.frame.geometryToken !== 'fake-only') return process.exit(2);
  respond({ok:true});
});
`;
  await writeFile(path, script, { mode: 0o700 });
  const adapter = createDesktopAdapter({ helperPath: path, platform: 'darwin', timeoutMs });
  return {
    adapter,
    log,
    pid,
    release,
    async cleanup() {
      await adapter.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function waitForFile(path: string) {
  for (let i = 0; i < 200; i++) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(10);
    }
  }
  throw new Error('Fake helper did not start');
}
function isGone(pid: number) {
  assert.throws(
    () => process.kill(pid, 0),
    (error: any) => error.code === 'ESRCH',
  );
}

test('desktop adapter defaults disabled; status is read-only; enabling still requires a screenshot', async () => {
  const fixture = await fakeHelper();
  try {
    const { adapter } = fixture;
    const status = await adapter.status();
    assert.equal(status.enabled, false);
    assert.equal(status.authorized, true);
    await assert.rejects(adapter.capture(), /尚未/);
    await assert.rejects(adapter.execute({ type: 'key', key: 'Meta+L' }), /尚未/);
    assert.equal(await readFile(fixture.log, 'utf8'), 'status\n');
    adapter.setEnabled(true);
    await assert.rejects(adapter.execute({ type: 'click', x: 0, y: 0 }), /截图/);
    const screenshot = await adapter.capture();
    assert.equal(screenshot.png.length, Buffer.from(png, 'base64').length);
    assert.deepEqual(
      await adapter.execute({ type: 'click', x: 0.5, y: 0.5, button: 'right', clickCount: 2 }),
      { ok: true },
    );
    await assert.rejects(adapter.execute({ type: 'click', x: 1, y: 0 }), /超出/);
    await adapter.close();
    adapter.setEnabled(true);
    await assert.rejects(adapter.execute({ type: 'key', key: 'Meta+L' }), /截图/);
    await adapter.capture();
    assert.deepEqual(await adapter.execute({ type: 'type', text: '测试🙂' }), { ok: true });
  } finally {
    await fixture.cleanup();
  }
});

test('desktop protocol validates bounded input and rejects unauthorized/malformed capture', async () => {
  for (const key of [
    'Meta+Shift+L',
    'ControlOrMeta+A',
    'Control+Alt+Delete',
    'ArrowUp',
    'F12',
    '[',
    '\\',
    '`',
  ])
    assert.doesNotThrow(() => validateDesktopInput({ type: 'key', key }));
  for (const input of [
    { type: 'key', key: 'Shell+L' },
    { type: 'key', key: 'Meta+osascript' },
    { type: 'click', x: NaN, y: 0 },
    { type: 'drag', x: 0, y: 0, toX: 1, toY: 1, durationMs: 2001 },
    { type: 'scroll', deltaY: 4001 },
    { type: 'type', text: 'x'.repeat(20_001) },
    { type: 'type', text: 'a\0b' },
    { type: 'key', key: 'Enter', shell: 'id' },
  ])
    assert.throws(() => validateDesktopInput(input));
  const denied = await fakeHelper('denied');
  const malformed = await fakeHelper('malformed');
  const headless = await fakeHelper('headless');
  try {
    assert.equal((await denied.adapter.status()).authorized, false);
    denied.adapter.setEnabled(true);
    await assert.rejects(denied.adapter.capture(), /permission denied/);
    malformed.adapter.setEnabled(true);
    await assert.rejects(malformed.adapter.capture(), /尺寸/);
    const unsupported = createDesktopAdapter({ platform: 'linux' });
    assert.equal((await unsupported.status()).available, false);
    assert.equal((await unsupported.status()).permissions.screenRecording, 'unknown');
    const noDisplay = await headless.adapter.status();
    assert.equal(noDisplay.available, false);
    assert.equal(noDisplay.authorized, false);
    assert.equal(noDisplay.width, 0);
  } finally {
    await denied.cleanup();
    await malformed.cleanup();
    await headless.cleanup();
  }
});

test('desktop cancellation sends TERM for release and waits for the fake child to exit', async () => {
  const fixture = await fakeHelper('hold');
  try {
    fixture.adapter.setEnabled(true);
    await fixture.adapter.capture();
    const controller = new AbortController();
    const pending = fixture.adapter.execute(
      { type: 'drag', x: 0, y: 0, toX: 0.5, toY: 0.5 },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending, /取消/);
    const pid = Number(await waitForFile(fixture.pid));
    controller.abort();
    await rejected;
    assert.equal(await readFile(fixture.release, 'utf8'), 'released');
    isGone(pid);
  } finally {
    await fixture.cleanup();
  }
});

test('desktop close aborts active input, clears frame, and permits later re-enable', async () => {
  const fixture = await fakeHelper('hold');
  try {
    fixture.adapter.setEnabled(true);
    await fixture.adapter.capture();
    const pending = fixture.adapter.execute({ type: 'key', key: 'Meta+L' });
    const rejected = assert.rejects(pending, /取消|变更/);
    const pid = Number(await waitForFile(fixture.pid));
    await fixture.adapter.close();
    await rejected;
    isGone(pid);
    assert.equal((await fixture.adapter.status()).enabled, false);
    fixture.adapter.setEnabled(true);
    await assert.rejects(fixture.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
  } finally {
    await fixture.cleanup();
  }
});

test('desktop close during helper access check cannot launch a late status process', async () => {
  const fixture = await fakeHelper();
  try {
    const pending = fixture.adapter.status();
    await fixture.adapter.close();
    const result = await pending;
    assert.equal(result.available, false);
    assert.match(result.reason ?? '', /取消/);
    await assert.rejects(readFile(fixture.log), (error: any) => error.code === 'ENOENT');
  } finally {
    await fixture.cleanup();
  }
});

test('desktop timeout kills a non-cooperative fake helper and waits for exit', async () => {
  const fixture = await fakeHelper('ignore', 2000);
  try {
    fixture.adapter.setEnabled(true);
    await fixture.adapter.capture();
    const pending = fixture.adapter.execute({ type: 'key', key: 'Enter' });
    const rejected = assert.rejects(pending, /超时/);
    const pid = Number(await waitForFile(fixture.pid));
    await rejected;
    isGone(pid);
  } finally {
    await fixture.cleanup();
  }
});

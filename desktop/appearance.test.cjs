'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const { createManagedAppearance, validAppearance, fileName } = require('./appearance.cjs');
const { createController } = require('./main.cjs');
const { localPartition } = require('./local-runtime.cjs');
const { fakeElectron, tempDir } = require('./test-fixture.cjs');
const raw = (avatarTheme = 'pandas') =>
  JSON.stringify({ version: 1, theme: 'dark', accent: 'neutral', spellCheck: false, avatarTheme });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('native appearance is bounded UTF-8, validates only non-credential fields and retains all preferences', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createManagedAppearance(dir);
  assert.deepEqual(store.read(), { value: null, available: true });
  const value = raw();
  assert.deepEqual(store.write(value), { available: true });
  assert.deepEqual(createManagedAppearance(dir).read(), { value, available: true });
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(join(dir, fileName)).mode & 0o777, 0o600);
  const max = value + ' '.repeat(2048 - Buffer.byteLength(value));
  assert.equal(validAppearance(max), true);
  for (const invalid of [
    max + ' ',
    max + '中',
    'null',
    '[]',
    '{}',
    raw('unknown'),
    JSON.stringify({ ...JSON.parse(value), token: 'synthetic' }),
  ]) {
    assert.equal(validAppearance(invalid), false);
    assert.equal(store.write(invalid).available, false);
    assert.equal(store.read().value, value);
  }
  const custom = {
    name: '熊猫伙伴',
    motif: 'pandas',
    colors: ['#1084fe', '#ff6700', '#00bca6'],
    badge: 'star',
    backdrop: 'halo',
  };
  assert.equal(
    store.write(
      JSON.stringify({
        ...JSON.parse(value),
        customAvatarTheme: custom,
        useCustomAvatarTheme: true,
      }),
    ).available,
    true,
  );
  assert.equal(
    validAppearance(
      JSON.stringify({
        ...JSON.parse(value),
        customAvatarTheme: { ...custom, url: 'https://example.test' },
      }),
    ),
    false,
  );
});

test('native preference IO rejects linked, oversized and non-regular entries without touching canaries', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, fileName),
    canary = join(dir, 'canary');
  fs.writeFileSync(canary, raw());
  const entries = [
    () => fs.linkSync(canary, target),
    () => fs.mkdirSync(target),
    () => fs.writeFileSync(target, ' '.repeat(2049)),
    () => fs.writeFileSync(target, 'invalid JSON'),
  ];
  if (process.platform !== 'win32')
    entries.push(
      () => fs.symlinkSync(canary, target),
      () => execFileSync('mkfifo', [target]),
    );
  for (const make of entries) {
    make();
    const store = createManagedAppearance(dir);
    assert.deepEqual(store.read(), { value: null, available: false });
    if (
      fs.lstatSync(target).isFile() &&
      fs.lstatSync(target).nlink === 1 &&
      fs.statSync(target).size <= 2048
    ) {
      assert.equal(
        store.write(raw('chicks')).available,
        true,
        'ordinary malformed preferences can be repaired',
      );
    } else assert.equal(store.write(raw('chicks')).available, false);
    assert.equal(fs.readFileSync(canary, 'utf8'), raw());
    fs.rmSync(target, { recursive: true, force: true });
  }
  const unavailable = createManagedAppearance(join(dir, 'absent'));
  assert.equal(unavailable.write(raw()).available, false);
  assert.deepEqual(
    unavailable.read(),
    { value: raw(), available: false },
    'this process retains the choice without claiming persistence',
  );
  assert.deepEqual(fs.readdirSync(dir), ['canary']);
});

async function controllerFixture(t) {
  const dir = tempDir(),
    fake = fakeElectron();
  const runtime = {
    starts: 0,
    stops: 0,
    available: () => true,
    hostControlAvailable: () => false,
    start: async () => {
      runtime.starts++;
      return { origin: 'http://127.0.0.1:43171', token: 'a'.repeat(64) };
    },
    stop: () => {
      runtime.stops++;
    },
  };
  fake.session.fromPartition(localPartition).fetch = async (url) =>
    Object.defineProperty(
      Response.json(
        new URL(url).pathname === '/api/account/local-session'
          ? {
              authenticated: true,
              user: { localOnly: true },
              workspaceId: '11111111-1111-4111-8111-111111111111',
            }
          : { ok: true, runtime: 'pi', architecture: 'platform', backend: 'rust' },
      ),
      'url',
      { value: url },
    );
  const controller = createController(fake, { dataDir: dir, localRuntime: runtime });
  controller.start();
  await flush();
  t.after(() => {
    controller.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const invoke = (channel, contents, value, frame = contents.mainFrame) => {
    const event = { sender: contents, senderFrame: frame };
    fake.ipc.get(`openbot-appearance:${channel}`)(event, value);
    return event.returnValue;
  };
  const connect = async (origin, managed = true) => {
    const pending = controller.connect(
      origin,
      managed ? { token: 'a'.repeat(64), hostControl: false } : undefined,
    );
    await flush();
    return { pending, contents: fake.views.at(-1).webContents };
  };
  return { dir, fake, runtime, controller, invoke, connect };
}

test('actual main handlers migrate while connecting, survive a changed local port and reject every foreign sender', async (t) => {
  const f = await controllerFixture(t),
    first = await f.connect('http://127.0.0.1:43171');
  assert.deepEqual(f.fake.views.at(-1).options.webPreferences.additionalArguments, [
    '--openbot-managed-appearance',
  ]);
  assert.equal(f.controller.state().status, 'connecting');
  assert.equal(f.invoke('read', first.contents).available, true);
  assert.equal(f.invoke('write', first.contents, raw()).available, true);
  assert.equal(f.invoke('read', first.contents).value, raw());
  const frame = first.contents.mainFrame;
  for (const foreign of [{ ...frame }, { ...frame, url: '' }]) {
    assert.equal(f.invoke('write', first.contents, raw('chicks'), foreign).available, false);
    assert.equal(f.invoke('read', first.contents, undefined, foreign).value, null);
  }
  for (const [key, changed] of [
    ['detached', true],
    ['origin', 'https://foreign.example.test'],
    ['url', ''],
  ]) {
    const before = frame[key];
    frame[key] = changed;
    assert.equal(f.invoke('read', first.contents).available, false);
    assert.equal(f.invoke('write', first.contents, raw('chicks')).available, false);
    frame[key] = before;
  }
  assert.equal(f.invoke('read', f.fake.windows[0].webContents).value, null);
  first.contents.loadGate.resolve();
  await first.pending;
  assert.equal(f.invoke('read', first.contents, 'unexpected').available, false);
  const second = await f.connect('http://127.0.0.1:43172');
  assert.equal(f.invoke('read', first.contents).value, null);
  assert.equal(f.invoke('write', first.contents, raw('chicks')).available, false);
  assert.equal(f.invoke('read', second.contents).value, raw());
  second.contents.loadGate.resolve();
  await second.pending;
  for (const origin of ['https://foreign.example.test', 'http://127.0.0.1:43172']) {
    const remote = await f.connect(origin, false);
    assert.equal(f.fake.views.at(-1).options.webPreferences.additionalArguments, undefined);
    assert.equal(f.invoke('read', remote.contents).value, null);
    assert.equal(f.invoke('write', remote.contents, raw('chicks')).available, false);
    remote.contents.loadGate.resolve();
    await remote.pending;
    assert.equal(f.invoke('read', remote.contents).value, null);
  }
  assert.equal(createManagedAppearance(f.dir).read().value, raw());
});

test('Ctrl/Cmd+R reloads the connected local page without restarting tasks; a failed connection still retries', async (t) => {
  const f = await controllerFixture(t),
    local = await f.connect('http://127.0.0.1:43171');
  local.contents.loadGate.resolve();
  await local.pending;
  const menu = () =>
    f.fake.calls.menu
      .at(-1)
      .items.flatMap((item) => item.submenu || [])
      .find((item) => item.accelerator === 'CmdOrCtrl+R');
  let reloaded = 0;
  local.contents.reload = () => {
    reloaded++;
  };
  const before = { starts: f.runtime.starts, stops: f.runtime.stops, views: f.fake.views.length };
  assert.equal(menu().label, '刷新页面');
  menu().click();
  assert.equal(reloaded, 1);
  assert.deepEqual(
    { starts: f.runtime.starts, stops: f.runtime.stops, views: f.fake.views.length },
    before,
  );
  const remote = await f.connect('https://foreign.example.test', false);
  remote.contents.loadGate.resolve();
  await remote.pending;
  remote.contents.emit('did-fail-load', {}, -105, '', '', true);
  assert.equal(f.controller.state().status, 'error');
  assert.equal(menu().label, '重新连接');
  const count = f.fake.views.length;
  menu().click();
  await flush();
  assert.equal(f.fake.views.length, count + 1);
  f.fake.views.at(-1).webContents.loadGate.resolve();
  await flush();
});

test('preload exposes only the fixed preference operations to an explicitly marked managed main frame', () => {
  const source = fs.readFileSync(join(__dirname, 'remote-preload.cjs'), 'utf8');
  for (const [managed, mainFrame] of [
    [false, true],
    [true, false],
    [true, true],
  ]) {
    const exposed = {},
      calls = [];
    runInNewContext(source, {
      process: { isMainFrame: mainFrame, argv: managed ? ['--openbot-managed-appearance'] : [] },
      location: { protocol: 'http:' },
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (key, value) => {
            exposed[key] = value;
          },
        },
        ipcRenderer: {
          sendSync: (...args) => {
            calls.push(args);
            return { value: null, available: true };
          },
        },
      }),
    });
    assert.equal(!!exposed.openbotAppearance, managed && mainFrame);
    if (exposed.openbotAppearance) {
      assert.deepEqual(Object.keys(exposed.openbotAppearance), ['read', 'write']);
      exposed.openbotAppearance.read('ignored');
      exposed.openbotAppearance.write(raw());
      assert.deepEqual(calls, [['openbot-appearance:read'], ['openbot-appearance:write', raw()]]);
    }
  }
});

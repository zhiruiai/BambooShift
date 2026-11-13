'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { rmSync } = require('node:fs');
const { createController } = require('./main.cjs');
const { localPartition, readLocalSelection } = require('./local-runtime.cjs');
const { tempDir, deferred, fakeElectron } = require('./test-fixture.cjs');

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, { available = true, language = 'en', startGate } = {}) {
  const dataDir = tempDir();
  const fake = fakeElectron();
  fake.app.getPreferredSystemLanguages = () => [language];
  const executions = { starts: [], stops: 0 };
  const localRuntime = {
    available: () => available,
    hostControlAvailable: () => available,
    stop: () => {
      executions.stops++;
    },
    start: async (options) => {
      executions.starts.push(options.hostControl);
      await startGate?.promise;
      return { origin: 'http://127.0.0.1:43171', token: 'a'.repeat(64) };
    },
  };
  fake.session.fromPartition(localPartition).fetch = async (url) => {
    const body =
      new URL(url).pathname === '/api/account/local-session'
        ? {
            authenticated: true,
            user: { localOnly: true },
            workspaceId: '11111111-1111-4111-8111-111111111111',
          }
        : { ok: true, runtime: 'pi', architecture: 'platform', backend: 'rust' };
    return Object.defineProperty(Response.json(body), 'url', { value: url });
  };
  const controller = createController(fake, { dataDir, localRuntime });
  controller.start();
  await flush();
  t.after(async () => {
    await controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const click = () =>
    fake.calls.menu
      .at(-1)
      .items.find((entry) => entry.label === (language === 'en' ? 'Workspace' : '空间'))
      .submenu.find(
        (entry) =>
          entry.label === (language === 'en' ? 'Workspace on this computer…' : '本机工作空间…'),
      )
      .click();
  const start = (hostControl = false) => {
    const sender = fake.windows.at(-1).webContents;
    return fake.ipc.get('openbot-client:start-local')(
      { sender, senderFrame: sender.mainFrame },
      { hostControl },
    );
  };
  const attach = async (opening) => {
    await flush();
    const view = fake.views.at(-1);
    assert.ok(view, 'a successful local start creates a product view');
    view.webContents.loadGate.resolve();
    await opening;
    assert.equal(controller.state().status, 'connected');
  };
  return { fake, controller, executions, dataDir, click, start, attach };
}

test('local menu reads the active mode in both languages without stopping or granting access', async (t) => {
  for (const language of ['en', 'zh-CN']) {
    for (const hostControl of [false, true]) {
      const f = await fixture(t, { language });
      await f.attach(f.start(hostControl));
      const before = f.executions.stops;
      f.click();
      await flush();
      const [, options] = f.fake.calls.dialogs.at(-1);
      assert.equal(
        options.message,
        language === 'en'
          ? hostControl
            ? 'Local computer control is enabled'
            : 'Your local workspace is running'
          : hostControl
            ? '本机整机操作已开启'
            : '本机个人空间正在运行',
      );
      const permissionText = language === 'en' ? /still require OS permission/ : /仍需系统授权/;
      if (hostControl) {
        assert.match(options.detail, permissionText);
        assert.match(options.detail, language === 'en' ? /approval rules/ : /仍需审批/);
      } else assert.doesNotMatch(options.detail, permissionText);
      assert.match(options.detail, language === 'en' ? /stops local tasks/ : /停止本机任务/);
      assert.match(
        options.detail,
        language === 'en' ? /Saved chats and files remain/ : /已保存的对话和文件保留/,
      );
      assert.ok(
        language === 'en' ? options.detail.split(/\s+/).length <= 80 : options.detail.length <= 130,
        'native status text stays concise enough for a small dialog',
      );
      assert.doesNotMatch(options.detail, /执行器|runner/);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.equal(f.executions.stops, before);
      assert.deepEqual(f.executions.starts, [hostControl]);
      assert.deepEqual(readLocalSelection(f.dataDir), { hostControl });
      assert.deepEqual(f.fake.calls.external, []);
      assert.equal(f.controller.state().status, 'connected');
    }
  }
});

test('only the explained native adjustment action returns the same local session to setup', async (t) => {
  const f = await fixture(t);
  await f.attach(f.start(true));
  const pending = deferred();
  f.fake.dialog.showMessageBox = (...args) => {
    f.fake.calls.dialogs.push(args);
    return pending.promise;
  };
  const before = f.executions.stops;
  f.click();
  f.click();
  assert.equal(f.fake.calls.dialogs.length, 1);
  assert.equal(f.executions.stops, before);
  assert.equal(f.fake.calls.dialogs[0][1].buttons[1], 'Return to startup to adjust');
  pending.resolve({ response: 1 });
  await flush();
  assert.equal(f.executions.stops, before + 1);
  assert.equal(f.controller.state().status, 'setup');
  assert.deepEqual(readLocalSelection(f.dataDir), { hostControl: true });
  assert.deepEqual(f.executions.starts, [true]);
});

test('a dialog result cannot stop a replacement connection or a hidden, replaced or destroyed window', async (t) => {
  for (const change of ['connection', 'hidden', 'window', 'destroyed']) {
    const f = await fixture(t);
    await f.attach(f.start());
    const pending = deferred();
    f.fake.dialog.showMessageBox = () => pending.promise;
    f.click();
    if (change === 'connection') {
      await f.attach(f.controller.connect('https://next.example.test'));
    } else if (change === 'hidden') f.fake.windows[0].visible = false;
    else if (change === 'destroyed') f.fake.windows[0].destroyed = true;
    else {
      f.controller.createWindow();
      await flush();
    }
    const before = f.executions.stops;
    pending.resolve({ response: 1 });
    await flush();
    assert.equal(f.executions.stops, before, `stale dialog after ${change}`);
    assert.equal(f.controller.state().status, 'connected');
    if (change === 'window') f.fake.windows.at(-1).destroyed = true;
  }
});

test('existing service connections explain execution location without claiming local permissions', async (t) => {
  for (const available of [false, true]) {
    const f = await fixture(t, { available });
    // A localhost service URL is not evidence that this client started the runner.
    await f.attach(f.controller.connect('http://127.0.0.1:43172'));
    f.click();
    await flush();
    const options = f.fake.calls.dialogs.at(-1)[1];
    assert.equal(options.message, 'Connected to an existing workspace');
    assert.match(options.detail, /does not automatically select this computer/);
    assert.equal(options.buttons.length, available ? 2 : 1);
    if (available) assert.match(options.detail, /tasks on the existing service continue/);
    else assert.match(options.detail, /no usable local runtime/);
    assert.deepEqual(f.executions.starts, []);
  }
});

test('idle and starting states offer no destructive action, and rejected dialogs can reopen', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { startGate: gate });
  f.click();
  await flush();
  assert.equal(f.fake.calls.dialogs.at(-1)[1].message, 'No workspace is open');
  assert.deepEqual(f.fake.calls.dialogs.at(-1)[1].buttons, ['OK']);
  const opening = f.start(true);
  const before = f.executions.stops;
  f.click();
  await flush();
  assert.equal(f.fake.calls.dialogs.at(-1)[1].message, 'Workspace is connecting or starting');
  assert.deepEqual(f.fake.calls.dialogs.at(-1)[1].buttons, ['OK']);
  assert.equal(f.executions.stops, before);
  gate.resolve();
  await f.attach(opening);
  f.fake.dialog.showMessageBox = async () => {
    throw Error('Window dismissed');
  };
  f.click();
  await flush();
  assert.equal(f.executions.stops, before);
  f.fake.dialog.showMessageBox = async (...args) => {
    f.fake.calls.dialogs.push(args);
    return { response: 0 };
  };
  f.click();
  await flush();
  assert.equal(f.fake.calls.dialogs.at(-1)[1].message, 'Local computer control is enabled');
  assert.equal(f.controller.state().status, 'connected');
});

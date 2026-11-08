'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { rmSync } = require('node:fs');
const { createController } = require('./main.cjs');
const { tempDir, fakeElectron, deferred } = require('./test-fixture.cjs');
const scope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  expectedUser: '22222222-2222-4222-8222-222222222222',
};
async function fixture() {
  const dataDir = tempDir(),
    fake = fakeElectron(),
    notices = [],
    requests = [];
  let clock = 1;
  fake.Notification = class extends EventEmitter {
    static isSupported() {
      return true;
    }
    constructor(value) {
      super();
      this.value = value;
      notices.push(this);
    }
    show() {
      this.shown = true;
    }
    close() {
      this.closed = true;
      this.emit('close');
    }
  };
  const controller = createController(fake, { dataDir, now: () => clock });
  controller.start();
  await Promise.resolve();
  const opening = controller.connect('https://bot.example.com');
  const contents = fake.views[0].webContents;
  contents.loadGate.resolve();
  await opening;
  contents.url = `https://bot.example.com/w/${scope.workspaceId}`;
  contents.mainFrame.url = contents.url;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const state = { user: scope.expectedUser, membership: true, active: true, response: 1 };
  let accountHook = async () => {};
  contents.session.fetch = async (url, init) => {
    requests.push({ url, init });
    await accountHook();
    return Response.json({
      authenticated: true,
      user: { id: state.user, status: state.active ? 'active' : 'suspended' },
      workspaces: state.membership ? [{ id: scope.workspaceId, status: 'active' }] : [],
    });
  };
  fake.dialog.showMessageBox = async (...args) => {
    fake.calls.dialogs.push(args);
    return { response: state.response };
  };
  const invoke = (method, value = scope, sender = event) =>
    fake.ipc.get(`openbot-notifications:${method}`)(sender, value);
  const arm = () => contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
  return {
    fake,
    controller,
    contents,
    event,
    state,
    requests,
    notices,
    invoke,
    arm,
    notice: (eventId = 'chief:completed:run-1') => ({
      ...scope,
      eventId,
      title: '小欧 · Task complete',
      body: '',
    }),
    accountHook: (hook) => {
      accountHook = hook;
    },
    tick: (amount) => {
      clock += amount;
    },
    close() {
      controller.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    async allow() {
      arm();
      assert.equal(await invoke('requestPermission'), 'granted');
    },
  };
}
test('native notifications require a real input, confirmation and active account membership', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.invoke('permission'), 'prompt');
    assert.equal(await f.invoke('requestPermission'), 'denied');
    assert.equal(f.fake.calls.dialogs.length, 0);
    f.arm();
    f.tick(5001);
    assert.equal(await f.invoke('requestPermission'), 'denied');
    f.state.response = 0;
    f.arm();
    assert.equal(await f.invoke('requestPermission'), 'denied');
    f.state.response = 1;
    await f.allow();
    assert.equal(await f.invoke('permission'), 'granted');
    assert.equal(await f.invoke('show', f.notice()), true);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].value.body, '');
    assert.equal(f.requests[0].init.redirect, 'error');
    assert.equal(f.requests[0].init.credentials, 'include');
    assert.equal(f.requests[0].url, 'https://bot.example.com/api/account/session');
    assert.equal(f.requests[0].init.headers['X-OpenBot-Expected-User'], scope.expectedUser);
    f.notices[0].emit('click');
    assert.equal(f.notices[0].closed, true);
    assert.deepEqual(f.fake.calls.external, []);
    assert.equal(await f.invoke('show', f.notice()), true);
    assert.equal(f.notices.length, 1, 'duplicate events cannot produce another notification');
    f.state.membership = false;
    assert.equal(await f.invoke('show', f.notice('run-2')), false);
    f.state.membership = true;
    f.state.active = false;
    assert.equal(await f.invoke('show', f.notice('run-3')), false);
  } finally {
    f.close();
  }
});
test('native notifications reject frames, external routes, secret bodies and unbounded payloads', async () => {
  const f = await fixture();
  try {
    await f.allow();
    const before = f.requests.length;
    assert.equal(
      await f.invoke('show', f.notice(), { ...f.event, senderFrame: { ...f.contents.mainFrame } }),
      false,
    );
    for (const value of [
      { ...f.notice(), url: 'https://external.example' },
      { ...f.notice(), body: 'conversation content' },
      { ...f.notice(), title: 'x'.repeat(121) },
      { ...f.notice(), title: 'control\nmessage' },
      { ...f.notice(), eventId: 'x'.repeat(385) },
      { ...f.notice(), workspaceId: {} },
    ])
      assert.equal(await f.invoke('show', value), false);
    assert.equal(f.requests.length, before);
    f.contents.url = 'https://bot.example.com/login';
    f.contents.mainFrame.url = f.contents.url;
    assert.equal(await f.invoke('show', f.notice()), false);
    assert.equal(f.notices.length, 0);
  } finally {
    f.close();
  }
});
test('cookie or navigation changes invalidate pending permissions and close delivered notices', async () => {
  const f = await fixture();
  try {
    await f.allow();
    await f.invoke('show', f.notice());
    f.contents.session.cookies.emit('changed', {}, {}, 'explicit', true);
    assert.equal(f.notices[0].closed, true);
    assert.equal(await f.invoke('permission'), 'prompt');
    await f.allow();
    const gate = deferred();
    f.accountHook(() => gate.promise);
    const pending = f.invoke('show', f.notice('pending-run'));
    f.contents.emit('did-start-navigation', {}, f.contents.url, false, true);
    gate.resolve();
    assert.equal(await pending, false);
    assert.equal(f.notices.length, 1);
    f.accountHook(async () => {});
    assert.equal(await f.invoke('permission'), 'prompt');
    await f.allow();
    f.state.user = '33333333-3333-4333-8333-333333333333';
    assert.equal(await f.invoke('show', f.notice('wrong-actor')), false);
  } finally {
    f.close();
  }
});
test('server switch fences delayed notifications and removes cookie listeners', async () => {
  const f = await fixture();
  try {
    await f.allow();
    const gate = deferred();
    f.accountHook(() => gate.promise);
    const pending = f.invoke('show', f.notice());
    f.controller.showSetup();
    gate.resolve();
    assert.equal(await pending, false);
    assert.equal(f.notices.length, 0);
    assert.equal(f.contents.session.cookies.listenerCount('changed'), 0);
  } finally {
    f.close();
  }
});
test('notification clear closes notices without resetting event deduplication or general media policy', async () => {
  const f = await fixture();
  try {
    await f.allow();
    await f.invoke('show', f.notice());
    await f.invoke('clear');
    assert.equal(f.notices[0].closed, true);
    assert.equal(await f.invoke('show', f.notice()), true);
    assert.equal(f.notices.length, 1);
    let allowed;
    f.contents.session.requestPermission(
      f.contents,
      'notifications',
      (value) => {
        allowed = value;
      },
      {},
    );
    assert.equal(allowed, false);
    for (let index = 0; index < 19; index++)
      assert.equal(await f.invoke('show', f.notice(`event-${index}`)), true);
    assert.equal(await f.invoke('show', f.notice('limited')), false);
    assert.equal(f.notices.length, 20);
  } finally {
    f.close();
  }
});

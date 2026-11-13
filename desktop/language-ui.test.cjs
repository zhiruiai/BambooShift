'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { setupDom } = require('./setup-dom-fixture.cjs');
const { deferred } = require('./test-fixture.cjs');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function bridgeFixture() {
  let listener;
  let state = { status: 'setup', url: 'http://127.0.0.1:3001', language: 'en' };
  const calls = [];
  const bridge = {
    getState: async () => state,
    onState(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    async setLanguage(language) {
      calls.push({ language });
      state = { ...state, language };
      listener?.(state);
      return state;
    },
    async connect(value) {
      calls.push(value);
      return {
        ...state,
        status: 'error',
        error: '连接超时。请检查网络和服务状态，然后重试相同地址。',
      };
    },
    async retry() {
      calls.push({ retry: true });
      return state;
    },
  };
  return {
    bridge,
    calls,
    publish(value) {
      state = { ...state, ...value };
      listener?.(state);
    },
  };
}

test('shipped setup DOM translates all declared labels and attributes while retaining an edited address', async () => {
  const fixture = bridgeFixture(),
    page = setupDom(fixture.bridge);
  await settle();
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.byId('page-title').textContent, 'Connect to your workspace');
  assert.equal(page.byId('workspace-url').attributes.placeholder, 'https://your-workspace.example');
  assert.equal(
    page.elements.find((item) => item.tag === 'img').attributes.alt,
    'BambooShift purple companion',
  );
  assert.match(
    page.elements.find((item) => item.attributes['data-i18n'] === 'accountLogin').textContent,
    /BambooShift account/,
  );
  assert.match(
    page.elements.find((item) => item.attributes['data-i18n'] === 'intro').textContent,
    /Create a workspace on this computer.*existing BambooShift service/,
  );
  assert.equal(page.byId('use-local').textContent, 'Fill in local address');
  for (const element of page.elements.filter((item) => item.attributes['data-i18n']))
    assert.doesNotMatch(element.textContent, /[\u3400-\u9fff]/);
  page.byId('workspace-url').value = 'https://my-draft.example.test';
  page.byId('workspace-url').emit('input');
  page.byId('client-language').value = 'zh-CN';
  await page.byId('client-language').emit('change');
  assert.equal(page.byId('page-title').textContent, '连接你的工作空间');
  assert.equal(page.byId('workspace-url').value, 'https://my-draft.example.test');
  assert.deepEqual(fixture.calls, [{ language: 'zh-CN' }]);
  assert.equal(page.byId('connect-button').disabled, false);
  fixture.publish({ language: 'en' });
  assert.equal(page.byId('workspace-url').value, 'https://my-draft.example.test');
  assert.equal(page.byId('connect-label').textContent, 'Connect to workspace');
  page.hide();
});

test('real setup submit validates and localizes failures without changing the original connection URL', async () => {
  const fixture = bridgeFixture(),
    page = setupDom(fixture.bridge);
  await settle();
  page.byId('workspace-url').value = 'https://example.test/path';
  page.byId('connect-form').emit('submit');
  await settle();
  assert.match(page.byId('error-message').textContent, /without a page path/);
  assert.equal(fixture.calls.length, 0);
  page.byId('workspace-url').value = 'https://workspace.example.test';
  page.byId('workspace-url').emit('input');
  page.byId('connect-form').emit('submit');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls)), [
    { url: 'https://workspace.example.test' },
  ]);
  assert.match(page.byId('error-message').textContent, /connection timed out/);
  assert.equal(page.byId('connect-label').textContent, 'Retry connection');
  fixture.publish({ status: 'error', error: '服务返回错误（503）。请检查所填地址，或稍后重试。' });
  assert.match(page.byId('error-message').textContent, /error \(503\)/);
  page.hide();
});

test('device preference failure remains usable and a late language reply cannot update a closed setup page', async () => {
  const fixture = bridgeFixture(),
    gate = deferred();
  fixture.bridge.setLanguage = () => gate.promise;
  const page = setupDom(fixture.bridge);
  await settle();
  page.byId('client-language').value = 'zh-CN';
  const changing = page.byId('client-language').emit('change');
  page.hide();
  gate.resolve({ language: 'zh-CN', languagePersisted: false });
  await changing;
  assert.equal(page.document.documentElement.lang, 'en');
  const next = setupDom({
    ...fixture.bridge,
    setLanguage: async () => ({ language: 'zh-CN', languagePersisted: false }),
  });
  await settle();
  next.byId('client-language').value = 'zh-CN';
  await next.byId('client-language').emit('change');
  assert.equal(next.document.documentElement.lang, 'zh-CN');
  assert.equal(next.byId('language-status').hidden, false);
  assert.match(next.byId('language-status').textContent, /未能保存/);
  assert.equal(next.byId('connect-button').disabled, false);
  next.hide();
});

test('preload exposes only a strict language enum without exposing IPC to product or subframes', async () => {
  const source = readFileSync(join(__dirname, 'preload.cjs'), 'utf8');
  let api;
  const calls = [];
  const run = (href, mainFrame = true) =>
    runInNewContext(source, {
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke: (...args) => {
            calls.push(args);
            return Promise.resolve();
          },
        },
      }),
      process: { isMainFrame: mainFrame },
      location: { href },
    });
  run('openbot-app://setup/');
  await api.setLanguage('en');
  assert.deepEqual(calls, [['openbot-client:set-language', 'en']]);
  for (const value of [null, {}, 'zh', 'en-US', 'https://example.test'])
    assert.throws(() => api.setLanguage(value));
  assert.equal(calls.length, 1);
  api = undefined;
  run('https://workspace.example.test');
  assert.equal(api, undefined);
  run('openbot-app://setup/', false);
  assert.equal(api, undefined);
});

test('the local workspace action shows availability and cancel without disturbing a remote address draft', async () => {
  const fixture = bridgeFixture();
  const startup = deferred();
  fixture.bridge.startLocal = () => startup.promise;
  fixture.bridge.cancelLocal = async () => ({
    status: 'setup',
    language: 'en',
    localAvailable: true,
  });
  const page = setupDom(fixture.bridge);
  await settle();
  assert.equal(page.byId('start-local').disabled, true);
  assert.match(page.byId('local-description').textContent, /no usable local runtime/);
  fixture.publish({ localAvailable: true });
  assert.equal(page.byId('start-local').disabled, false);
  page.byId('workspace-url').value = 'https://draft.example.test';
  page.byId('workspace-url').emit('input');
  page.byId('start-local').emit('click');
  assert.equal(page.byId('cancel-local').hidden, false);
  assert.equal(page.byId('connect-button').disabled, true);
  page.byId('cancel-local').emit('click');
  await settle();
  assert.equal(page.byId('start-local').disabled, false);
  assert.equal(page.byId('workspace-url').value, 'https://draft.example.test');
  startup.resolve({ status: 'connected' });
  await settle();
  assert.equal(page.document.body.hidden, false);
  page.hide();
});

test('full computer control is offered only for an eligible local package and starts unchecked', async () => {
  const fixture = bridgeFixture();
  fixture.bridge.startLocal = async (choice) => {
    fixture.calls.push(choice);
    return { status: 'setup', localAvailable: true, localHostControlAvailable: true };
  };
  const page = setupDom(fixture.bridge);
  await settle();
  assert.equal(page.byId('host-control-option').hidden, true);
  fixture.publish({ localAvailable: true, localHostControlAvailable: true });
  assert.equal(page.byId('host-control-option').hidden, false);
  assert.equal(page.byId('host-control').checked, false);
  page.byId('host-control').checked = true;
  page.byId('host-control').emit('change');
  page.byId('start-local').emit('click');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls)), [{ hostControl: true }]);
  page.hide();
});

test('failed computer-control startup can retry without control while preserving the remote draft', async () => {
  const fixture = bridgeFixture();
  fixture.publish({ localAvailable: true, localHostControlAvailable: true });
  fixture.bridge.startLocal = async (choice) => {
    fixture.calls.push(choice);
    return {
      status: choice.hostControl ? 'setup' : 'connected',
      language: 'en',
      localAvailable: true,
      localHostControlAvailable: true,
      localError: choice.hostControl
        ? '整机操作组件未能启动。请重试，或取消勾选后打开本机工作空间。'
        : '',
    };
  };
  const page = setupDom(fixture.bridge);
  await settle();
  assert.match(page.byId('local-description').textContent, /No account or sign-in needed/);
  assert.match(page.byId('local-description').textContent, /Configure your own model/);
  page.byId('workspace-url').value = 'https://draft.example.test';
  page.byId('workspace-url').emit('input');
  page.byId('host-control').checked = true;
  page.byId('host-control').emit('change');
  page.byId('start-local').emit('click');
  await settle();
  assert.equal(page.byId('local-error').hidden, false);
  assert.match(page.byId('local-error').textContent, /turn off computer control/);
  assert.equal(page.byId('start-local').disabled, false);
  assert.equal(page.byId('host-control').disabled, false);
  assert.equal(page.byId('host-control').checked, true);
  assert.equal(page.byId('workspace-url').value, 'https://draft.example.test');
  page.byId('host-control').checked = false;
  page.byId('host-control').emit('change');
  page.byId('start-local').emit('click');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls)), [
    { hostControl: true },
    { hostControl: false },
  ]);
  assert.equal(page.byId('local-error').hidden, true);
  assert.equal(page.document.body.hidden, true);
  page.hide();
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const {
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} = require('node:fs');
const { createClientLanguage } = require('./language.cjs');
const { createController } = require('./main.cjs');
const catalog = require('./ui/i18n.js');
const { tempDir, fakeElectron, sharedDownloadFixture } = require('./test-fixture.cjs');

test('device language follows system on first use, persists separately, validates data and tolerates denied storage', () => {
  const directory = tempDir();
  try {
    const language = createClientLanguage(directory, 'en-GB');
    assert.equal(language.snapshot().language, 'en');
    assert.equal(language.t('heading'), 'Connect to your workspace');
    language.set('zh-CN');
    assert.equal(createClientLanguage(directory, 'en').snapshot().language, 'zh-CN');
    if (process.platform !== 'win32')
      assert.equal(statSync(join(directory, 'client-language.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'client-language.json'), 'utf8')), {
      version: 1,
      language: 'zh-CN',
    });
    assert.throws(() => language.set({ language: 'en', url: 'https://example.test' }));
    assert.throws(() => language.set('fr'));
    writeFileSync(join(directory, 'client-language.json'), '{"version":1,"language":"invalid"}');
    assert.equal(createClientLanguage(directory, 'zh-TW').snapshot().language, 'zh-CN');
    writeFileSync(join(directory, 'client-language.json'), 'broken');
    assert.equal(createClientLanguage(directory, 'fr-FR').snapshot().language, 'en');
    const blocked = createClientLanguage(join(directory, 'absent'), 'en');
    assert.equal(blocked.set('zh-CN').languagePersisted, false);
    assert.equal(
      blocked.snapshot().language,
      'zh-CN',
      'failed writes preserve this session choice',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('language preferences do not read or modify a linked file', (t) => {
  const directory = tempDir();
  try {
    const outside = join(directory, 'unrelated.json');
    writeFileSync(outside, '{"version":1,"language":"zh-CN"}');
    try {
      symlinkSync(outside, join(directory, 'client-language.json'), 'file');
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      t.skip('The Windows account cannot create file symlinks');
      return;
    }
    const safe = createClientLanguage(directory, 'en');
    assert.equal(safe.snapshot().language, 'en', 'linked preference is not read');
    safe.set('en');
    assert.match(readFileSync(outside, 'utf8'), /zh-CN/, 'preference write never follows a link');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real setup IPC and native menus change only device language, retain connection and reject remote language IPC', async () => {
  const directory = tempDir(),
    electron = fakeElectron();
  electron.app.getPreferredSystemLanguages = () => ['en-US'];
  const controller = createController(electron, { dataDir: directory });
  try {
    controller.start();
    await Promise.resolve();
    const setup = electron.windows[0].webContents;
    const sender = { sender: setup, senderFrame: setup.mainFrame };
    const invoke = (value, actor = sender) =>
      electron.ipc.get('openbot-client:set-language')(actor, value);
    assert.equal(controller.state().language, 'en');
    assert.equal(controller.state().error, undefined);
    assert.ok(electron.calls.menu.at(-1).items.some((item) => item.label === 'Edit'));
    assert.equal(invoke('zh-CN').language, 'zh-CN');
    assert.ok(electron.calls.menu.at(-1).items.some((item) => item.label === '编辑'));
    assert.throws(() => invoke('en-US'));
    assert.throws(() => invoke({ language: 'en' }));
    const connecting = controller.connect('https://workspace.example.test');
    const product = electron.views[0].webContents;
    product.loadGate.resolve();
    await connecting;
    const origin = controller.state().url;
    const languageMenu = electron.calls.menu
      .at(-1)
      .items.find((item) => item.label === '客户端语言');
    languageMenu.submenu.find((item) => item.label === 'English').click();
    assert.equal(controller.state().url, origin);
    assert.equal(controller.state().status, 'connected');
    assert.equal(electron.views.length, 1, 'language does not reload or replace product view');
    assert.equal(product.messages.length, 0, 'language does not write into the remote product');
    assert.throws(
      () => invoke('zh-CN', { sender: product, senderFrame: product.mainFrame }),
      /connection page/,
    );
    product.emit(
      'context-menu',
      {},
      { selectionText: 'A user message 中文', linkURL: 'https://external.example.test' },
    );
    const context = electron.calls.contextMenus.at(-1);
    assert.equal(context[0].label, 'Open Link in Browser…');
    await context[0].click();
    await Promise.resolve();
    assert.equal(electron.calls.dialogs.at(-1)[1].title, 'Open Link in Browser');
    assert.match(electron.calls.dialogs.at(-1)[1].message, /^Open https:\/\/external/);
    assert.equal(
      electron.calls.external.length,
      0,
      'the default Cancel still does not open external sites',
    );
    controller.showSetup();
    await assert.rejects(
      electron.ipc.get('openbot-client:connect')(sender, { url: 'http://remote.example.test' }),
      /Remote services require HTTPS/,
    );
    assert.equal(invoke('zh-CN').language, 'zh-CN');
    assert.equal(controller.state().url, origin);
  } finally {
    controller.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native shared-file save labels use selected language without changing download authorization', async () => {
  const f = await sharedDownloadFixture();
  try {
    const menu = f.fake.calls.menu.at(-1).items.find((item) => item.label === '客户端语言');
    menu.submenu.find((item) => item.label === 'English').click();
    f.arm();
    assert.deepEqual(await f.invoke(), { status: 'saved' });
    assert.equal(f.fake.calls.saves.at(-1)[1].title, 'Save Shared File');
    assert.equal(f.fake.calls.saves.at(-1)[1].buttonLabel, 'Save');
    assert.equal(readFileSync(f.destination).equals(f.file), true);
    await assert.rejects(f.invoke(), /Click the shared file download button/);
  } finally {
    f.close();
  }
});

test('both catalogs retain the same keys and placeholders and package only static localization resources', async () => {
  assert.deepEqual(Object.keys(catalog.catalogs.en), Object.keys(catalog.catalogs['zh-CN']));
  for (const [key, value] of Object.entries(catalog.catalogs.en)) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0);
    assert.equal(/[\u3400-\u9fff]/.test(value), false, key);
    assert.deepEqual(
      value.match(/\{\{\w+\}\}/g),
      catalog.catalogs['zh-CN'][key].match(/\{\{\w+\}\}/g),
    );
  }
  const { collectClientFiles } = await import('../scripts/package-client.mjs');
  const { files } = await collectClientFiles(join(__dirname));
  assert.ok(files.includes('language.cjs'));
  assert.ok(files.includes('ui/i18n.js'));
  assert.ok(
    !files.some((file) => file.includes('.test.') || file.includes('client-language.json')),
  );
  const { writeMacLocalizations } = await import('../scripts/client-localizations.mjs');
  const directory = tempDir();
  try {
    await writeMacLocalizations(directory);
    assert.match(
      readFileSync(join(directory, 'Contents/Resources/en.lproj/InfoPlist.strings'), 'utf8'),
      /review the text before sending/,
    );
    assert.match(
      readFileSync(join(directory, 'Contents/Resources/zh-Hans.lproj/InfoPlist.strings'), 'utf8'),
      /由你确认后发送/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

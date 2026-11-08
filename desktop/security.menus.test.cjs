'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
  statSync,
} = require('node:fs');
const { join } = require('node:path');
const {
  normalizeServerOrigin,
  partitionFor,
  setupAsset,
  trustedSetupSender,
  allowedResource,
  allowedDownload,
  sharedFileDownloadRequest,
  rendererPreferences,
  ConnectionState,
  SETUP_URL,
} = require('./security.cjs');
const {
  createController,
  createSetupProtocolHandler,
  installSessionPolicy,
  saveLastOrigin,
  readLastOrigin,
} = require('./main.cjs');

const {
  tempDir,
  deferred,
  fakeElectron,
  sharedDownloadIds,
  sharedDownloadPath,
  sharedOwnerPath,
  sharedDownloadFixture,
  waitForDownload,
  controllerWithFilesystem,
} = require('./test-fixture.cjs');

test('native Help lists available shortcuts in the client language and opens one dialog at a time', async () => {
  const dataDir = tempDir();
  const fake = fakeElectron();
  fake.app.getPreferredSystemLanguages = () => ['en'];
  const controller = createController(fake, { dataDir });
  const shortcutItem = (label) =>
    fake.calls.menu
      .at(-1)
      .items.find((item) => item.role === 'help')
      .submenu.find((item) => item.label === label);
  const modifier = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
  try {
    controller.start();
    await Promise.resolve();
    const pendingDialog = deferred();
    fake.dialog.showMessageBox = (...args) => {
      fake.calls.dialogs.push(args);
      return pendingDialog.promise;
    };
    const item = shortcutItem('Keyboard shortcuts');
    assert.equal(item.accelerator, 'CmdOrCtrl+/');
    item.click();
    item.click();
    assert.equal(fake.calls.dialogs.length, 1);
    const [window, setupDialog] = fake.calls.dialogs[0];
    assert.equal(window, fake.windows[0]);
    assert.equal(setupDialog.message, 'Keyboard shortcuts');
    assert.ok(setupDialog.detail.includes(`${modifier}/    Keyboard shortcuts`));
    assert.doesNotMatch(setupDialog.detail, /Search conversations/);
    pendingDialog.resolve({ response: 0 });
    await pendingDialog.promise;

    const language = fake.calls.menu.at(-1).items.find((item) => item.label === 'Client language');
    language.submenu.find((item) => item.label === '简体中文').click();
    const opening = controller.connect('https://one.example.com');
    fake.views[0].webContents.loadGate.resolve();
    await opening;
    shortcutItem('键盘快捷键').click();
    assert.equal(fake.calls.dialogs.length, 2);
    const workspaceDialog = fake.calls.dialogs[1][1];
    assert.equal(workspaceDialog.message, '键盘快捷键');
    assert.ok(workspaceDialog.detail.includes(`${modifier}K    搜索会话`));
    assert.ok(workspaceDialog.detail.includes(`${modifier},    打开设置`));
    assert.match(workspaceDialog.detail, /Shift\+Enter    在输入框中换行/);
    assert.deepEqual(fake.calls.external, []);
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('main edit menu uses native macOS roles without JS; other platforms and context actions retain safe routing', async () => {
  const dataDir = tempDir();
  const fake = fakeElectron();
  const controller = createController(fake, { dataDir });
  const actions = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'];
  const editItems = () =>
    fake.calls.menu
      .at(-1)
      .items.find((item) => item.label === '编辑')
      .submenu.filter((item) => item.type !== 'separator');
  const runItems = (items, target, expected = actions) => {
    const priorNative = fake.calls.responders.length;
    const priorEdits = target?.edits.length;
    const priorFocus = target?.focusCount;
    const callbacks = [];
    assert.equal(items.length, expected.length);
    for (const [index, item] of items.entries()) {
      if (item.role) {
        assert.equal(process.platform, 'darwin');
        assert.equal(item.role, expected[index]);
        assert.deepEqual(
          Object.keys(item),
          ['role', 'label'],
          'native editing must not depend on a JS callback or custom accelerator',
        );
        continue;
      }
      assert.equal(item.role, undefined, 'a role would override the explicit click handler');
      assert.match(item.accelerator, /^CmdOrCtrl\+/);
      item.click();
      callbacks.push(expected[index]);
    }
    if (!target) {
      assert.equal(
        fake.calls.responders.length,
        priorNative,
        'invalid targets cannot reach the native responder',
      );
    } else if (process.platform === 'darwin') {
      assert.deepEqual(
        fake.calls.responders.slice(priorNative),
        callbacks.map((action) => `${action}:`),
      );
      assert.equal(target.edits.length, priorEdits, 'macOS edits are routed only by AppKit');
      assert.equal(
        target.focusCount,
        priorFocus,
        'menu actions must not steal the native responder',
      );
    } else {
      assert.deepEqual(target.edits.slice(priorEdits), expected);
      assert.equal(fake.calls.responders.length, priorNative);
    }
  };
  try {
    controller.start();
    await Promise.resolve();
    const setup = fake.windows[0].webContents;
    runItems(editItems(), setup);

    const opening = controller.connect('https://one.example.com');
    const remote = fake.views[0].webContents;
    runItems(
      editItems().filter((item) => item.role === 'paste' || item.accelerator === 'CmdOrCtrl+V'),
      setup,
      ['paste'],
    );
    assert.deepEqual(remote.edits, [], 'a hidden, loading view must not receive edit commands');
    remote.loadGate.resolve();
    await opening;
    const setupEdits = setup.edits.length;
    const appItems = editItems();
    runItems(appItems, remote);
    assert.equal(
      setup.edits.length,
      setupEdits,
      'connected editing must not reach the hidden setup page',
    );
    const focused = remote.focusCount;
    controller.focus();
    assert.equal(remote.focusCount, focused + 1, 'reactivation restores focus to the active view');
    if (process.platform === 'darwin') {
      remote.focused = false;
      setup.focused = false;
      const priorFocus = remote.focusCount;
      runItems(appItems, remote);
      assert.equal(remote.focusCount, priorFocus, 'native dialog editing must not steal its focus');
      remote.focused = true;
      setup.focused = true;
      const win = fake.windows[0];
      win.focused = false;
      const focusWindow = win.focus;
      win.focus = () => {}; // A native save/open sheet remains the key window.
      controller.focus();
      assert.equal(
        remote.focusCount,
        priorFocus,
        'activation must not take focus from a native sheet',
      );
      runItems(appItems, remote);
      assert.deepEqual(
        remote.edits,
        [],
        'stale WebContents focus must not steal native filename edits',
      );
      assert.equal(remote.focusCount, priorFocus);
      win.focus = focusWindow;
      win.focused = true;
    }

    remote.emit('context-menu', {}, { isEditable: true });
    const staleContext = fake.calls.contextMenus.at(-1).filter((item) => item.click);
    runItems(staleContext, remote);
    remote.emit('context-menu', {}, { selectionText: 'selected message' });
    runItems(
      fake.calls.contextMenus.at(-1).filter((item) => item.click),
      remote,
      ['copy', 'selectAll'],
    );

    controller.showSetup();
    const oldCount = remote.edits.length;
    runItems(staleContext);
    assert.equal(
      remote.edits.length,
      oldCount,
      'a dismissed space cannot receive old context-menu clicks',
    );
    assert.equal(
      setup.edits.length,
      setupEdits,
      'stale context actions must not fall through to setup',
    );
    runItems(
      editItems().filter((item) => item.role === 'selectAll' || item.accelerator === 'CmdOrCtrl+A'),
      setup,
      ['selectAll'],
    );

    const nextOpening = controller.connect('https://two.example.com');
    const next = fake.views[1].webContents;
    next.loadGate.resolve();
    await nextOpening;
    runItems(appItems, next);
    assert.equal(remote.edits.length, oldCount);
    assert.equal(
      fake.views[1].options.webPreferences.preload,
      join(__dirname, 'remote-preload.cjs'),
    );
    const session = fake.sessions.get(partitionFor('https://two.example.com'));
    for (const permission of ['clipboard-read', 'clipboard-sanitized-write']) {
      let granted;
      session.requestPermission(next, permission, (value) => {
        granted = value;
      });
      assert.equal(
        granted,
        false,
        'native edit routing must not broaden web clipboard permissions',
      );
    }
    fake.windows[0].destroyed = true;
    const priorNext = next.edits.length;
    runItems(appItems);
    assert.equal(next.edits.length, priorNext, 'closed windows do not receive edit commands');
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

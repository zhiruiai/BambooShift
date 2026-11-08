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

test('clipboard write consumes one recent native input only for the active foreground same-origin main frame', async () => {
  const dataDir = tempDir();
  const fake = fakeElectron();
  let time = 100;
  const controller = createController(fake, { dataDir, now: () => time });
  try {
    controller.start();
    await Promise.resolve();
    const win = fake.windows[0];
    const opening = controller.connect('https://one.example.com');
    const contents = fake.views[0].webContents;
    const ses = fake.sessions.get(partitionFor('https://one.example.com'));
    const details = { isMainFrame: true, requestingUrl: 'https://one.example.com/' };
    const mouse = (target = contents) => {
      target.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' });
      target.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
    };
    const request = (
      permission = 'clipboard-sanitized-write',
      value = details,
      target = contents,
      session = ses,
    ) => {
      let granted,
        calls = 0;
      session.requestPermission(
        target,
        permission,
        (result) => {
          granted = result;
          calls++;
        },
        value,
      );
      assert.equal(calls, 1);
      return granted;
    };
    mouse();
    assert.equal(request(), false, 'loading/unattached views cannot obtain a token');
    contents.loadGate.resolve();
    await opening;
    assert.equal(request(), false, 'foreground alone is insufficient');
    mouse();
    assert.equal(
      ses.checkPermission(
        contents,
        'clipboard-sanitized-write',
        'https://one.example.com',
        details,
      ),
      false,
    );
    assert.equal(
      request(),
      true,
      'permission query neither grants nor consumes the one-shot request token',
    );
    assert.equal(request(), false, 'a second write from the same click is denied');
    assert.equal(
      ses.checkPermission(
        contents,
        'clipboard-sanitized-write',
        'https://one.example.com',
        details,
      ),
      false,
    );

    for (const permission of [
      'clipboard-read',
      'deprecated-sync-clipboard-read',
      'unknown',
      'media',
    ]) {
      mouse();
      assert.equal(request(permission), false, permission);
    }
    for (const invalid of [
      undefined,
      {},
      { ...details, isMainFrame: false },
      { ...details, requestingUrl: 'https://other.example.com/' },
      { ...details, requestingUrl: 'https://one.example.com/other' },
    ]) {
      mouse();
      // Explicitly invoke the handler because the helper's default details are valid.
      let granted;
      ses.requestPermission(
        contents,
        'clipboard-sanitized-write',
        (value) => {
          granted = value;
        },
        invalid,
      );
      assert.equal(granted, false);
    }
    const cases = [
      [win, 'visible', false],
      [win, 'focused', false],
      [win, 'minimized', true],
      [contents, 'focused', false],
      [contents, 'loading', true],
      [contents, 'focusedFrame', {}],
      [contents.mainFrame, 'visibilityState', 'hidden'],
      [contents.mainFrame, 'detached', true],
      [contents.mainFrame, 'origin', 'https://other.example.com'],
      [contents.mainFrame, 'url', 'https://other.example.com/'],
    ];
    for (const [object, key, value] of cases) {
      mouse();
      const old = object[key];
      object[key] = value;
      assert.equal(request(), false, `must reject ${key}=${String(value)}`);
      object[key] = old;
      assert.equal(
        request(),
        false,
        'a rejected request cannot revive its token after focus/state recovery',
      );
    }
    mouse();
    time += 1001;
    assert.equal(request(), false, 'input token expires after one second');
    for (const [emitter, event] of [
      [contents, 'blur'],
      [contents, 'did-start-navigation'],
      [contents, 'did-navigate-in-page'],
      [win, 'blur'],
      [win, 'hide'],
      [win, 'minimize'],
    ]) {
      mouse();
      emitter.emit(event, {});
      assert.equal(request(), false, `${event} revokes an unused token`);
    }
    mouse();
    const oldFrame = contents.mainFrame;
    contents.mainFrame = { ...oldFrame };
    contents.focusedFrame = contents.mainFrame;
    assert.equal(request(), false, 'a new document cannot inherit the previous frame token');
    contents.mainFrame = oldFrame;
    contents.focusedFrame = oldFrame;
    mouse();
    assert.equal(request('clipboard-sanitized-write', details, win.webContents), false);
    assert.equal(request('clipboard-sanitized-write', details, null), false);
    assert.equal(
      request('clipboard-sanitized-write', details, contents, fake.sessions.get('openbot-setup')),
      false,
    );

    for (const input of [{ type: 'mouseMove' }, { type: 'mouseUp', button: 'right' }]) {
      contents.emit('before-mouse-event', {}, input);
      assert.equal(request(), false);
    }
    contents.emit('click', {});
    assert.equal(request(), false, 'DOM-style events cannot mint a native input token');
    for (const input of [
      { type: 'keyDown', key: 'Enter', isAutoRepeat: true },
      { type: 'keyDown', key: 'Enter', isComposing: true },
      { type: 'keyDown', key: 'Enter', control: true },
      { type: 'keyDown', key: 'a' },
    ]) {
      contents.emit('before-input-event', {}, input);
      assert.equal(request(), false);
    }
    for (const input of [
      { type: 'keyDown', key: 'Enter' },
      { type: 'keyUp', key: ' ' },
    ]) {
      contents.emit('before-input-event', {}, input);
      assert.equal(request(), true, 'keyboard activation allows one write');
      assert.equal(request(), false);
    }
    mouse();
    controller.showSetup();
    assert.equal(request(), false, 'old view token is discarded when changing space');
    const second = controller.connect('https://two.example.com');
    const next = fake.views[1].webContents;
    next.loadGate.resolve();
    await second;
    mouse(next);
    assert.equal(
      request(
        'clipboard-sanitized-write',
        { ...details, requestingUrl: 'https://two.example.com/' },
        next,
      ),
      false,
      'a callback for a different origin partition cannot authorize the new view',
    );
    mouse(next);
    const nextSession = fake.sessions.get(partitionFor('https://two.example.com'));
    assert.equal(
      request(
        'clipboard-sanitized-write',
        { ...details, requestingUrl: 'https://two.example.com/' },
        next,
        nextSession,
      ),
      true,
    );
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dictation permits one audio-only capture after native activation and rejects stale, hidden or foreign frames', async () => {
  const dataDir = tempDir();
  const fake = fakeElectron();
  let time = 100;
  const controller = createController(fake, { dataDir, now: () => time });
  try {
    controller.start();
    await Promise.resolve();
    const win = fake.windows[0];
    const opening = controller.connect('https://voice.example.com');
    const contents = fake.views[0].webContents;
    const ses = fake.sessions.get(partitionFor('https://voice.example.com'));
    const details = {
      isMainFrame: true,
      requestingUrl: 'https://voice.example.com/',
      securityOrigin: 'https://voice.example.com',
      mediaTypes: ['audio'],
    };
    const mouse = () =>
      contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
    const request = (value = details, permission = 'media', target = contents, session = ses) => {
      let granted,
        count = 0;
      session.requestPermission(
        target,
        permission,
        (result) => {
          granted = result;
          count++;
        },
        value,
      );
      assert.equal(count, 1);
      return granted;
    };
    mouse();
    assert.equal(request(), false, 'loading views cannot start capture');
    contents.loadGate.resolve();
    await opening;
    assert.equal(request(), false, 'connection alone cannot start capture');
    mouse();
    assert.equal(ses.checkPermission(contents, 'media', details.securityOrigin, details), false);
    assert.equal(request(), true, 'permission checks preserve the explicit request token');
    assert.equal(request(), false, 'capture does not become a standing grant');
    mouse();
    assert.equal(
      request({ ...details, securityOrigin: 'https://voice.example.com/' }),
      true,
      'equivalent origin URL serialization does not block a valid microphone request',
    );
    for (const invalid of [
      {},
      { ...details, mediaTypes: undefined },
      { ...details, mediaTypes: [] },
      { ...details, mediaTypes: ['video'] },
      { ...details, mediaTypes: ['audio', 'video'] },
      { ...details, isMainFrame: false },
      { ...details, securityOrigin: 'https://foreign.example.com' },
      { ...details, requestingUrl: 'https://voice.example.com/other' },
    ]) {
      mouse();
      assert.equal(request(invalid), false);
      assert.equal(request(), false, 'invalid media requests consume the input token');
    }
    for (const permission of [
      'display-capture',
      'clipboard-read',
      'notifications',
      'geolocation',
    ]) {
      mouse();
      assert.equal(request(details, permission), false);
    }
    const states = [
      [win, 'visible', false],
      [win, 'focused', false],
      [win, 'minimized', true],
      [contents, 'focused', false],
      [contents, 'loading', true],
      [contents, 'focusedFrame', {}],
      [contents.mainFrame, 'detached', true],
      [contents.mainFrame, 'visibilityState', 'hidden'],
    ];
    for (const [object, key, value] of states) {
      mouse();
      const old = object[key];
      object[key] = value;
      assert.equal(request(), false, `capture rejected when ${key}=${String(value)}`);
      object[key] = old;
      assert.equal(request(), false, 'returning to the foreground cannot revive capture');
    }
    for (const [emitter, event] of [
      [win, 'blur'],
      [win, 'hide'],
      [win, 'minimize'],
      [contents, 'blur'],
      [contents, 'did-start-navigation'],
      [contents, 'did-navigate-in-page'],
    ]) {
      mouse();
      emitter.emit(event, {});
      assert.equal(request(), false, `${event} clears pending capture`);
    }
    mouse();
    time += 5001;
    assert.equal(request(), false, 'capture activation expires');
    for (const input of [
      { type: 'keyDown', key: 'd', meta: true },
      { type: 'keyDown', key: 'D', control: true },
      { type: 'keyDown', key: 'Enter' },
      { type: 'keyUp', key: ' ' },
    ]) {
      contents.emit('before-input-event', {}, input);
      assert.equal(request(), true);
      assert.equal(request(), false);
    }
    for (const input of [
      { type: 'keyDown', key: 'd' },
      { type: 'keyDown', key: 'd', meta: true, isAutoRepeat: true },
      { type: 'keyDown', key: 'd', control: true, isComposing: true },
      { type: 'keyDown', key: 'd', meta: true, alt: true },
    ]) {
      contents.emit('before-input-event', {}, input);
      assert.equal(request(), false);
    }
    contents.emit('before-input-event', {}, { type: 'keyDown', key: 'd', meta: true });
    assert.equal(
      request(details, 'clipboard-sanitized-write'),
      false,
      'dictation shortcut does not grant clipboard access',
    );
    assert.equal(request(), true);
    mouse();
    assert.equal(
      request(details, 'media', win.webContents),
      false,
      'setup view cannot use a product token',
    );
    mouse();
    assert.equal(request(details, 'media', contents, fake.sessions.get('openbot-setup')), false);
    controller.showSetup();
    assert.equal(request(), false, 'old connections cannot record');
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

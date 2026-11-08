'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const { createController } = require('./main.cjs');
const { tempDir, fakeElectron } = require('./test-fixture.cjs');

test('the version bridge returns the native package version only to the active product main frame', async () => {
  const dataDir = tempDir(),
    fake = fakeElectron();
  fake.app.getVersion = () => '1.2.3+synthetic';
  const controller = createController(fake, { dataDir });
  try {
    controller.start();
    await Promise.resolve();
    const opening = controller.connect('https://bot.example.test');
    const contents = fake.views[0].webContents;
    contents.loadGate.resolve();
    await opening;
    const event = { sender: contents, senderFrame: contents.mainFrame };
    const read = fake.ipc.get('openbot-client:get-version');
    assert.equal(read(event), '1.2.3+synthetic');
    assert.throws(() => read(event, { version: '99.0.0' }));
    assert.throws(() => read({ ...event, senderFrame: { ...contents.mainFrame } }));
    assert.throws(() => read({ ...event, sender: fake.windows[0].webContents }));
    const original = contents.url;
    contents.url = 'https://external.example.test';
    assert.throws(() => read(event));
    contents.url = original;
    contents.mainFrame.detached = true;
    assert.throws(() => read(event));
    contents.mainFrame.detached = false;
    controller.showSetup();
    assert.throws(() => read(event));
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  MACOS_ACCESSIBILITY_CAPABILITY,
  MACOS_APP_LAUNCH_CAPABILITY,
  WORKSPACE_SCOPE_HEADER,
} from '../../../shared/computer-screens.js';
import { createDesktopAdapter } from '../../../server/workers/computer-runtime/desktop.js';
import { validateAccessibilityAction } from '../../../server/workers/computer-runtime/desktop-accessibility.js';
import { createComputerWorker } from '../../../server/workers/computer-runtime/http/worker.js';

const bundleId = 'test.example.Notes';
const identity = 'a'.repeat(64);

test('app launch uses an installed bundle ID and a strict private identity', () => {
  for (const value of [
    'Notes',
    'test..Notes',
    '.test.Notes',
    'test.Notes.',
    'foo/bar',
    'app.id\n',
    'Com.OpenBot.Client',
  ]) {
    assert.throws(() =>
      validateAccessibilityAction({ type: 'desktop_ax_open_target', bundleId: value }),
    );
  }
  assert.throws(() =>
    validateAccessibilityAction({ type: 'desktop_ax_open_target', bundleId, identity }),
  );
  assert.throws(() =>
    validateAccessibilityAction({
      type: 'desktop_ax_open',
      bundleId,
      identity: identity.toUpperCase(),
    }),
  );
  assert.throws(() => validateAccessibilityAction({ type: 'desktop_ax_open', bundleId }));
  assert.deepEqual(validateAccessibilityAction({ type: 'desktop_ax_open', bundleId, identity }), {
    type: 'desktop_ax_open',
    bundleId,
    identity,
  });
});

test('the AX worker checks native launch capability and never captures or logs the approved identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bambooshift-app-launch-'));
  const helperPath = join(dir, 'fake-helper');
  const enabled = join(dir, 'launch-supported');
  const permissions = join(dir, 'permission-revoked');
  const events = join(dir, 'events');
  await writeFile(
    helperPath,
    `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }));
if (payload.op === 'status') {
  const ready = !fs.existsSync(${JSON.stringify(permissions)});
  reply({
    available: true, authorized: false, width: 96, height: 80, displays: [],
    accessibilityAvailable: true, accessibilityReady: ready,
    ...(fs.existsSync(${JSON.stringify(enabled)}) ? { appLaunchAvailable: true } : {}),
    permissions: { screenRecording: 'denied', accessibility: ready ? 'granted' : 'denied' },
  });
} else {
  fs.appendFileSync(${JSON.stringify(events)}, payload.op + '\\n');
  if (payload.op === 'ax_open_target') {
    assert.deepEqual(Object.keys(payload).sort(), ['app', 'enabled', 'op']);
    assert.equal(payload.enabled, true);
    const bundleId = payload.app === 'test.example.Protected' ? 'com.openbot.client' : ${JSON.stringify(bundleId)};
    reply({ app: { bundleId, name: 'Example Notes' }, identity: ${JSON.stringify(identity)} });
  } else if (payload.op === 'ax_open') {
    assert.equal(payload.app, ${JSON.stringify(bundleId)});
    assert.equal(payload.enabled, true);
    if (payload.appIdentity === ${JSON.stringify(identity)}) {
      reply({ ok: true, extra: payload.appIdentity });
    } else {
      process.stdout.write(JSON.stringify({ ok: false, error: { code: 'AX_STALE_APP', message: payload.appIdentity } }));
    }
  } else {
    assert.fail('Unexpected native operation');
  }
}
`,
    { mode: 0o700 },
  );
  const token = 'synthetic-app-launch-worker-token';
  const scope = '049e74ed-3a90-4645-9317-af0b35038685';
  const worker = createComputerWorker({
    token,
    workspaceDir: join(dir, 'workspace'),
    desktopAdapter: createDesktopAdapter({ helperPath, platform: 'darwin' }),
    hostDesktop: true,
    workspaceScopeId: scope,
  });
  const server = worker.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { Authorization: `Bearer ${token}` };
    const health = () =>
      fetch(origin + '/health', { headers: auth }).then((response) => response.json());
    const before = await health();
    assert.ok(before.capabilities.includes(MACOS_ACCESSIBILITY_CAPABILITY));
    assert.ok(!before.capabilities.includes(MACOS_APP_LAUNCH_CAPABILITY));
    const headers = {
      ...auth,
      'X-OpenBot-Worker-Instance': before.instanceId,
      'X-OpenBot-Control-Origin': before.controlOrigin ?? 'none',
      [WORKSPACE_SCOPE_HEADER]: scope,
      'Content-Type': 'application/json',
    };
    const post = (path: string, input: unknown) =>
      fetch(origin + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
    const lookup = { type: 'desktop_ax_open_target', bundleId: bundleId.toLowerCase() };
    const open = { type: 'desktop_ax_open', bundleId, identity };
    assert.equal((await post('/execute', lookup)).status, 400);
    assert.equal((await post('/surface', { surface: 'accessibility', confirm: true })).status, 200);
    assert.equal((await post('/execute', lookup)).status, 400);
    await writeFile(enabled, '');
    assert.ok((await health()).capabilities.includes(MACOS_APP_LAUNCH_CAPABILITY));
    assert.equal((await post('/execute-with-frame', open)).status, 400);
    assert.equal(
      (await post('/execute', { ...lookup, bundleId: 'Com.OpenBot.Client' })).status,
      400,
    );
    assert.equal(
      (await post('/execute', { ...lookup, bundleId: 'test.example.Protected' })).status,
      400,
    );
    assert.equal(
      (await post('/execute', { ...lookup, bundleId: 'test.example.Other' })).status,
      400,
    );
    const resolved = await post('/execute', lookup);
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), { app: 'Example Notes', bundleId, identity });
    const changedIdentity = 'b'.repeat(64);
    const stale = await post('/execute', { ...open, identity: changedIdentity });
    assert.equal(stale.status, 400);
    assert.deepEqual(await stale.json(), {
      code: 'AX_STALE_APP',
      error: '目标应用身份已变化，请重新发起启动申请。',
    });
    const launched = await post('/execute', open);
    assert.equal(launched.status, 200);
    assert.deepEqual(await launched.json(), { ok: true });
    const after = await health();
    assert.equal(after.surface, 'accessibility');
    assert.equal(after.desktop.permissions.screenRecording, 'denied');
    await writeFile(permissions, '');
    assert.ok((await health()).capabilities.includes(MACOS_APP_LAUNCH_CAPABILITY));
    assert.equal((await post('/execute', open)).status, 400);
    const operations = (await readFile(events, 'utf8')).trim().split('\n');
    assert.deepEqual(operations, [
      'ax_open_target',
      'ax_open_target',
      'ax_open_target',
      'ax_open',
      'ax_open',
    ]);
    const audit = await readFile(join(dir, 'audit', 'computer.jsonl'), 'utf8');
    assert.ok(audit.includes('desktop_ax_open'));
    for (const secret of [identity, changedIdentity, bundleId, 'Example Notes'])
      assert.ok(!audit.includes(secret));
  } finally {
    await worker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WORKSPACE_SCOPE_HEADER } from '../../../shared/computer-screens.js';
import { createDesktopAdapter } from '../../../server/workers/computer-runtime/desktop.js';
import {
  createDesktopAccessibility,
  validateAccessibilityAction,
} from '../../../server/workers/computer-runtime/desktop-accessibility.js';
import { createComputerWorker } from '../../../server/workers/computer-runtime/http/worker.js';

const native = {
  app: { pid: 12345, bundleId: 'test.example.Notes', name: 'Example Notes' },
  windowTitle: 'Example note',
  snapshotToken: 'a'.repeat(64),
  elements: [
    { id: '1', depth: 0, role: 'AXWindow', label: 'Example note', enabled: true, actions: [] },
    {
      id: '2',
      depth: 1,
      role: 'AXButton',
      label: 'Apply',
      enabled: true,
      actions: ['press'],
      elementToken: 'b'.repeat(64),
    },
    {
      id: '3',
      depth: 1,
      role: 'AXTextField',
      label: 'Title',
      enabled: true,
      actions: ['setText'],
      elementToken: 'c'.repeat(64),
    },
  ],
  truncated: false,
};
const selectedTokens = [
  native.snapshotToken,
  ...native.elements.flatMap((row) => row.elementToken ?? []),
];

test('a tokenized snapshot rejects missing, invalid and misplaced tokens and clears older views', async () => {
  const [window, press, type] = native.elements;
  const { elementToken: _omitted, ...incomplete } = type;
  for (const elements of [
    [window, press, incomplete],
    [window, press, { ...type, elementToken: null }],
    [window, press, { ...type, elementToken: type.elementToken!.toUpperCase() }],
    [{ ...window, elementToken: 'd'.repeat(64) }, press, type],
  ]) {
    let reply: unknown = native;
    const adapter = createDesktopAccessibility(
      async () => reply,
      () => {},
    );
    const before = await adapter.execute({ type: 'desktop_ax_inspect' });
    assert.ok('snapshotToken' in before);
    reply = { ...native, elements };
    await assert.rejects(adapter.execute({ type: 'desktop_ax_inspect' }), /控件列表无效/);
    await assert.rejects(
      adapter.execute({
        type: 'desktop_ax_press',
        snapshotToken: before.snapshotToken,
        elementId: '2',
      }),
      { code: 'AX_STALE_SNAPSHOT' },
    );
  }
  assert.throws(
    () =>
      validateAccessibilityAction({
        type: 'desktop_ax_press',
        snapshotToken: native.snapshotToken,
        elementId: '2',
        elementToken: press.elementToken,
      }),
    /有效控件/,
  );
});

test('Worker binds approved controls to private native tokens without publishing tokens or allowing stale mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bambooshift-ax-binding-'));
  const helperPath = join(dir, 'fake-helper');
  const changed = join(dir, 'changed');
  const events = join(dir, 'events');
  await writeFile(
    helperPath,
    `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const tree = ${JSON.stringify(native)};
const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }));
if (request.op === 'status') {
  reply({ available: true, authorized: false, width: 100, height: 80, displays: [],
    accessibilityAvailable: true, accessibilityReady: true,
    permissions: { screenRecording: 'denied', accessibility: 'granted' },
  });
} else {
  fs.appendFileSync(${JSON.stringify(events)}, request.op + '\\n');
  if (request.op === 'ax_inspect') {
    reply(tree);
  } else {
    assert.equal(request.enabled, true);
    assert.equal(request.appPid, tree.app.pid);
    assert.equal(request.appBundleId, tree.app.bundleId);
    assert.equal(request.snapshotToken, tree.snapshotToken);
    const row = tree.elements.find((element) => element.id === request.elementId);
    assert.equal(request.elementToken, row.elementToken);
    if (fs.existsSync(${JSON.stringify(changed)})) {
      return process.stdout.write(JSON.stringify({ ok: false, error: { code: 'AX_STALE_SNAPSHOT', message: request.elementToken } }));
    }
    assert.equal(request.op, 'ax_set_text');
    assert.equal(request.elementId, '3');
    assert.equal(request.text, 'Updated note');
    reply({ ok: true, elementToken: request.elementToken });
  }
}
`,
    { mode: 0o700 },
  );
  const token = 'synthetic-app-binding-worker-token';
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
    const health = await (await fetch(origin + '/health', { headers: auth })).json();
    const headers = {
      ...auth,
      'X-OpenBot-Worker-Instance': health.instanceId,
      'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
      [WORKSPACE_SCOPE_HEADER]: scope,
      'Content-Type': 'application/json',
    };
    const request = (path: string, body: unknown) =>
      fetch(origin + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    const exec = (body: unknown) => request('/execute', body);
    const inspect = async () => {
      const response = await exec({ type: 'desktop_ax_inspect', app: native.app.bundleId });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(
        !body.includes('elementToken') && selectedTokens.every((token) => !body.includes(token)),
      );
      return JSON.parse(body);
    };
    assert.equal(
      (await request('/surface', { surface: 'accessibility', confirm: true })).status,
      200,
    );
    const first = await inspect();
    const pressRef = { snapshotToken: first.snapshotToken, elementId: '2' };
    const target = await exec({ type: 'desktop_ax_target', ...pressRef });
    assert.deepEqual(await target.json(), {
      app: native.app.name,
      label: 'Apply',
      role: 'AXButton',
      windowTitle: native.windowTitle,
    });
    await writeFile(changed, '');
    const pressed = await exec({ type: 'desktop_ax_press', ...pressRef });
    assert.equal(pressed.status, 400);
    assert.deepEqual(await pressed.json(), {
      code: 'AX_STALE_SNAPSHOT',
      error: '应用窗口或控件已变化，请重新查看应用后操作。',
    });
    assert.equal((await exec({ type: 'desktop_ax_press', ...pressRef })).status, 400);
    await rm(changed);
    const next = await inspect();
    const typeRef = { snapshotToken: next.snapshotToken, elementId: '3' };
    const textTarget = await exec({ type: 'desktop_ax_target', action: 'setText', ...typeRef });
    assert.equal(textTarget.status, 200);
    assert.deepEqual(
      await (await exec({ type: 'desktop_ax_set_text', ...typeRef, text: 'Updated note' })).json(),
      { ok: true },
    );
    const audit = await readFile(join(dir, 'audit', 'computer.jsonl'), 'utf8');
    assert.ok(
      !audit.includes('elementToken') && selectedTokens.every((token) => !audit.includes(token)),
    );
    assert.deepEqual((await readFile(events, 'utf8')).trim().split('\n'), [
      'ax_inspect',
      'ax_press',
      'ax_inspect',
      'ax_set_text',
    ]);
  } finally {
    await worker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

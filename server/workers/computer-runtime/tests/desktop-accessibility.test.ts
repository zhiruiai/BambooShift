import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_SCOPE_HEADER } from '../../../../shared/computer-screens.js';
import { createDesktopAdapter } from '../desktop.js';
import {
  createDesktopAccessibility,
  nativeAccessibilityError,
  validateAccessibilityAction,
} from '../desktop-accessibility.js';
import { createComputerWorker } from '../http/worker.js';

const nativeToken = 'f'.repeat(64);
const app = { pid: 12345, bundleId: 'test.example.Notes', name: 'Example Notes' };
const tree = {
  app,
  windowTitle: 'Test notes',
  snapshotToken: nativeToken,
  elements: [
    { id: '1', depth: 0, role: 'AXWindow', label: 'Test notes', enabled: true, actions: [] },
    { id: '2', depth: 1, role: 'AXButton', label: 'Apply', enabled: true, actions: ['press'] },
    { id: '3', depth: 1, role: 'AXButton', label: 'Disabled', enabled: false, actions: ['press'] },
    {
      id: '4',
      depth: 1,
      role: 'AXTextArea',
      label: 'Note body',
      enabled: true,
      actions: ['setText'],
    },
    { id: '5', depth: 1, role: 'AXTextField', label: 'Secure field', enabled: true, actions: [] },
  ],
  truncated: false,
};
const approvedText = '\t保留👩‍💻\n空格  ';

test('AX cannot inspect BambooShift by display name or bundled app ID', async () => {
  const adapter = createDesktopAccessibility(
    async () => ({ ...tree, app: { ...app, bundleId: 'Com.OpenBot.Client' } }),
    () => {},
  );
  for (const app of ['BambooShift', 'com.openbot.client']) {
    await assert.rejects(adapter.execute({ type: 'desktop_ax_inspect', app }), /审批界面/);
  }
});

test('AX text input preserves whitespace and valid Unicode and rejects unsafe input', () => {
  const input = { type: 'desktop_ax_set_text', snapshotToken: nativeToken, elementId: '4' };
  assert.deepEqual(validateAccessibilityAction({ ...input, text: approvedText }), {
    ...input,
    text: approvedText,
  });
  const limit = '🔖'.repeat(2000);
  assert.equal(
    (validateAccessibilityAction({ ...input, text: limit }) as { text: string }).text,
    limit,
  );
  for (const text of ['', null, limit + '!', 'a\0', 'a\r', 'a\u009F', 'a\uD801']) {
    assert.throws(() => validateAccessibilityAction({ ...input, text }), /1–2000/);
  }
});

test('large app trees stay within the reply budget and only listed rows can be pressed', async () => {
  const elements = Array.from({ length: 200 }, (_, index) => ({
    id: String(index + 1),
    depth: 1,
    role: 'AXButton',
    label: '界'.repeat(300),
    enabled: true,
    actions: ['press'],
  }));
  const adapter = createDesktopAccessibility(
    async () => ({ ...tree, elements }),
    () => {},
  );
  const observed = await adapter.execute({ type: 'desktop_ax_inspect' });
  assert.ok('elements' in observed);
  assert.equal(observed.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 128 * 1024);
  assert.ok(observed.elements.length < elements.length);
  await assert.rejects(
    adapter.execute({
      type: 'desktop_ax_press',
      snapshotToken: observed.snapshotToken,
      elementId: '200',
    }),
    /不可点击/,
  );
});

test('a resolved control stays available through approval without extending the lookup or other controls', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls: Record<string, unknown>[] = [];
  const adapter = createDesktopAccessibility(
    async (request) => {
      calls.push(request);
      return request.op === 'ax_inspect' ? tree : { ok: true };
    },
    () => {},
  );
  const observed = await adapter.execute({ type: 'desktop_ax_inspect' });
  assert.ok('snapshotToken' in observed);
  const ref = { snapshotToken: observed.snapshotToken, elementId: '2' };
  now += 110_000;
  await adapter.execute({ type: 'desktop_ax_target', ...ref });
  now += 10 * 60_000;
  const stale = { code: 'AX_STALE_SNAPSHOT' };
  await assert.rejects(adapter.execute({ type: 'desktop_ax_target', ...ref }), stale);
  await assert.rejects(
    adapter.execute({ type: 'desktop_ax_set_text', ...ref, elementId: '4', text: 'other' }),
    stale,
  );
  assert.deepEqual(await adapter.execute({ type: 'desktop_ax_press', ...ref }), { ok: true });
  await assert.rejects(adapter.execute({ type: 'desktop_ax_press', ...ref }), stale);
  const later = await adapter.execute({ type: 'desktop_ax_inspect' });
  assert.ok('snapshotToken' in later);
  const next = { snapshotToken: later.snapshotToken, elementId: '2' };
  await adapter.execute({ type: 'desktop_ax_target', ...next });
  now += 11 * 60_000;
  await assert.rejects(adapter.execute({ type: 'desktop_ax_press', ...next }), stale);
  assert.deepEqual(
    calls.map((request) => request.op),
    ['ax_inspect', 'ax_press', 'ax_inspect'],
  );
});

test('native AX diagnostics forward only known codes and fixed text', () => {
  const known = nativeAccessibilityError('ax_inspect', {
    code: 'AX_APP_UNAVAILABLE',
    message: 'private label',
  });
  assert.ok(known);
  assert.deepEqual(
    { code: 'code' in known ? known.code : undefined, message: known.message },
    {
      code: 'AX_APP_UNAVAILABLE',
      message: '找不到唯一的目标应用，请检查应用标识符。',
    },
  );
  const unknown = nativeAccessibilityError('ax_press', {
    code: 'private bundle',
    message: 'private label',
  });
  assert.ok(unknown);
  assert.ok(!('code' in unknown));
  assert.equal(unknown.message, 'Mac 应用操作失败。');
});

async function accessibilityFixture(dir: string) {
  const helperPath = join(dir, 'fake-desktop');
  const events = join(dir, 'events');
  const revoked = join(dir, 'revoked');
  const stale = join(dir, 'stale');
  await writeFile(
    helperPath,
    `#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(data);
  fs.appendFileSync(${JSON.stringify(events)}, request.op + '\\n');
  const reply = (result) => process.stdout.write(JSON.stringify({ ok: true, result }));
  const ready = !fs.existsSync(${JSON.stringify(revoked)});
  if (request.op === 'status') return reply({
    available: true, accessibilityAvailable: true, accessibilityReady: ready,
    authorized: false, width: 100, height: 80,
    displays: [], permissions: { screenRecording: 'denied', accessibility: ready ? 'granted' : 'denied' }
  });
  assert.equal(request.enabled, true);
  if (request.op === 'ax_inspect') {
    assert.equal(request.app, ${JSON.stringify(app.bundleId)});
    return reply(${JSON.stringify(tree)});
  }
  if (request.op === 'ax_press') {
    assert.ok(!Object.hasOwn(request, 'elementToken'));
    assert.equal(request.appPid, ${app.pid});
    assert.equal(request.appBundleId, ${JSON.stringify(app.bundleId)});
    assert.equal(request.snapshotToken, ${JSON.stringify(nativeToken)});
    assert.equal(request.elementId, '2');
    return reply({ ok: true });
  }
  if (request.op === 'ax_set_text') {
    assert.ok(!Object.hasOwn(request, 'elementToken'));
    assert.equal(request.appPid, ${app.pid});
    assert.equal(request.appBundleId, ${JSON.stringify(app.bundleId)});
    assert.equal(request.snapshotToken, ${JSON.stringify(nativeToken)});
    assert.equal(request.elementId, '4');
    assert.equal(request.text, ${JSON.stringify(approvedText)});
    if (fs.existsSync(${JSON.stringify(stale)}))
      return process.stdout.write(JSON.stringify({
        ok: false, error: { code: 'AX_STALE_SNAPSHOT', message: request.text }
      }));
    return reply({ ok: true, debugText: request.text });
  }
  assert.fail('unexpected native operation ' + request.op);
});
`,
    { mode: 0o700 },
  );
  return { helperPath, events, revoked, stale };
}

test('workspace-scoped AX Worker needs no capture permission and uses a one-time observed control', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bambooshift-ax-worker-'));
  const { helperPath, events, revoked, stale } = await accessibilityFixture(dir);
  const token = 'synthetic-accessibility-worker-token';
  const workspace = '049e74ed-3a90-4645-9317-af0b35038685';
  const worker = createComputerWorker({
    token,
    workspaceDir: join(dir, 'workspace'),
    desktopAdapter: createDesktopAdapter({ helperPath, platform: 'darwin' }),
    hostDesktop: true,
    workspaceScopeId: workspace,
  });
  const server = worker.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { Authorization: `Bearer ${token}` };
    const health = await (await fetch(base + '/health', { headers: auth })).json();
    assert.equal(health.surface, 'browser');
    assert.equal(health.desktop.authorized, false);
    assert.equal(health.desktop.accessibilityReady, true);
    assert.ok(health.capabilities.includes('macos-accessibility-v1'));
    const headers = {
      ...auth,
      'X-OpenBot-Worker-Instance': health.instanceId,
      'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
      [WORKSPACE_SCOPE_HEADER]: workspace,
      'Content-Type': 'application/json',
    };
    const post = (path: string, body: unknown = {}, overrides: Record<string, string> = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { ...headers, ...overrides },
        body: JSON.stringify(body),
      });
    const inspect = { type: 'desktop_ax_inspect', app: app.bundleId };
    assert.equal((await post('/execute', inspect)).status, 400);
    assert.equal((await post('/surface', { surface: 'desktop', confirm: true })).status, 409);
    assert.equal((await post('/surface', { surface: 'accessibility' })).status, 400);
    const surface = { surface: 'accessibility', confirm: true };
    const enabled = await post('/surface', surface);
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).surface, 'accessibility');
    assert.equal((await fetch(base + '/screenshot', { headers })).status, 503);
    assert.equal((await post('/takeover/start')).status, 409);
    assert.equal((await post('/execute', { type: 'desktop_screenshot' })).status, 400);
    assert.equal(
      (await post('/execute', inspect, { [WORKSPACE_SCOPE_HEADER]: 'another-workspace' })).status,
      409,
    );

    const before = await (await post('/execute', inspect)).json();
    const current = await (await post('/execute', inspect)).json();
    assert.deepEqual(current.elements, tree.elements);
    assert.notEqual(current.snapshotToken, nativeToken);
    assert.notEqual(current.snapshotToken, before.snapshotToken);
    assert.match(current.snapshotToken, /^[a-f0-9]{64}$/);
    const target = {
      type: 'desktop_ax_target',
      snapshotToken: current.snapshotToken,
      elementId: '2',
    };
    const press = { ...target, type: 'desktop_ax_press' };
    const lookup = await post('/execute', target);
    assert.equal(lookup.status, 200);
    assert.deepEqual(await lookup.json(), {
      app: app.name,
      label: 'Apply',
      role: 'AXButton',
      windowTitle: tree.windowTitle,
    });
    assert.equal((await post('/execute', { ...press, elementId: '3' })).status, 400);
    const expired = await post('/execute', { ...press, snapshotToken: before.snapshotToken });
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).code, 'AX_STALE_SNAPSHOT');
    assert.equal((await post('/execute-with-frame', press)).status, 400);
    assert.equal((await post('/execute', press)).status, 200);
    assert.equal((await post('/execute', press)).status, 400);

    const editable = await (await post('/execute', inspect)).json();
    const textTarget = { ...target, snapshotToken: editable.snapshotToken, elementId: '4' };
    const setText = { ...textTarget, type: 'desktop_ax_set_text', text: approvedText };
    assert.equal((await post('/execute', textTarget)).status, 400);
    for (const elementId of ['2', '5']) {
      const unavailable = await post('/execute', { ...textTarget, elementId, action: 'setText' });
      assert.equal(unavailable.status, 400);
      assert.match((await unavailable.json()).error, /无法填写文字/);
    }
    const textLookup = await post('/execute', { ...textTarget, action: 'setText' });
    assert.equal(textLookup.status, 200);
    assert.deepEqual(await textLookup.json(), {
      app: app.name,
      windowTitle: tree.windowTitle,
      label: 'Note body',
      role: 'AXTextArea',
    });
    assert.equal((await post('/execute', { ...setText, text: approvedText + '\0' })).status, 400);
    assert.equal((await post('/execute-with-frame', setText)).status, 400);
    await writeFile(stale, '');
    const changedValue = await post('/execute', setText);
    assert.equal(changedValue.status, 400);
    const failure = await changedValue.json();
    assert.equal(failure.code, 'AX_STALE_SNAPSHOT');
    assert.match(failure.error, /应用窗口或控件已变化/);
    await rm(stale);
    assert.equal((await post('/execute', setText)).status, 400);
    const fresh = await (await post('/execute', inspect)).json();
    const successful = await post('/execute', { ...setText, snapshotToken: fresh.snapshotToken });
    assert.equal(successful.status, 200);
    assert.deepEqual(await successful.json(), { ok: true });

    const later = await (await post('/execute', inspect)).json();
    await writeFile(revoked, '');
    const denied = await (await fetch(base + '/health', { headers })).json();
    assert.ok(denied.capabilities.includes('macos-accessibility-v1'));
    assert.equal(denied.desktop.accessibilityReady, false);
    assert.equal((await post('/execute', inspect)).status, 400);
    await rm(revoked);
    assert.equal(
      (await post('/execute', { ...press, snapshotToken: later.snapshotToken })).status,
      400,
    );
    const beforeSwitch = await (await post('/execute', inspect)).json();
    assert.equal((await post('/surface', { surface: 'browser' })).status, 200);
    assert.equal((await post('/surface', surface)).status, 200);
    assert.equal(
      (await post('/execute', { ...press, snapshotToken: beforeSwitch.snapshotToken })).status,
      400,
    );
    const operations = (await readFile(events, 'utf8')).trim().split('\n');
    assert.deepEqual(
      operations.filter((op) => op !== 'status'),
      [
        'ax_inspect',
        'ax_inspect',
        'ax_press',
        'ax_inspect',
        'ax_set_text',
        'ax_inspect',
        'ax_set_text',
        'ax_inspect',
        'ax_inspect',
      ],
    );
    const audit = await readFile(join(dir, 'audit', 'computer.jsonl'), 'utf8');
    assert.ok(audit.includes('desktop_ax_press'));
    assert.ok(audit.includes('desktop_ax_set_text'));
    assert.ok(!audit.includes(current.snapshotToken) && !audit.includes(app.bundleId));
    assert.ok(!audit.includes('保留') && !audit.includes('Note body'));
  } finally {
    await worker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'managed personal Worker enables Mac apps without host desktop or shell access',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bambooshift-managed-ax-'));
    const { helperPath, events, revoked } = await accessibilityFixture(dir);
    const workspaceId = '049e74ed-3a90-4645-9317-af0b35038685';
    const executable = fileURLToPath(
      new URL('../../computer-worker/local-entry.ts', import.meta.url),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', executable], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const closed = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(
        JSON.stringify({
          workspace: join(dir, 'workspace'),
          workspaceId,
          publicOrigin: null,
          hostControl: false,
          desktopDriver: null,
          accessibilityHelper: helperPath,
        }) + '\n',
      );
      const line = await Promise.race([
        once(lines, 'line').then(([line]) => line as string),
        closed.then(() => {
          throw new Error('Managed AX Worker exited before becoming ready.');
        }),
      ]);
      const { url, token } = JSON.parse(line);
      const auth = { Authorization: `Bearer ${token}` };
      const health = await (await fetch(url + '/health', { headers: auth })).json();
      assert.equal(health.workspaceScopeId, workspaceId);
      assert.equal(health.surface, 'browser');
      assert.ok(health.capabilities.includes('macos-accessibility-v1'));
      assert.ok(health.capabilities.includes('workspace-shared-screen-v1'));
      assert.ok(!health.capabilities.includes('workspace-host-desktop-v1'));
      assert.ok(!health.capabilities.includes('local-shell-v1'));
      assert.equal(health.desktop.kind, 'host');
      assert.equal(health.desktop.available, false);
      assert.equal(health.desktop.accessibilityReady, true);
      assert.equal(health.desktop.accessibilityPermission, 'granted');
      assert.equal(health.desktop.permissions.accessibility, 'denied');
      const headers = {
        ...auth,
        'X-OpenBot-Worker-Instance': health.instanceId,
        'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
        [WORKSPACE_SCOPE_HEADER]: workspaceId,
        'Content-Type': 'application/json',
      };
      const post = (path: string, body: unknown) =>
        fetch(url + path, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      const inspect = { type: 'desktop_ax_inspect', app: app.bundleId };
      assert.equal((await post('/execute', inspect)).status, 400);
      assert.equal((await post('/surface', { surface: 'desktop', confirm: true })).status, 409);
      assert.equal((await post('/surface', { surface: 'accessibility' })).status, 400);
      const entered = await post('/surface', { surface: 'accessibility', confirm: true });
      assert.equal(entered.status, 200);
      assert.equal((await entered.json()).desktop.enabled, true);
      assert.equal((await fetch(url + '/screenshot', { headers })).status, 503);
      const observation = await post('/execute', inspect);
      assert.equal(observation.status, 200);
      const { snapshotToken } = await observation.json();
      const applied = await post('/execute', {
        type: 'desktop_ax_set_text',
        snapshotToken,
        elementId: '4',
        text: approvedText,
      });
      assert.equal(applied.status, 200);
      assert.deepEqual(await applied.json(), { ok: true });
      await writeFile(revoked, '');
      const afterRevocation = await (await fetch(url + '/health', { headers: auth })).json();
      assert.ok(afterRevocation.capabilities.includes('macos-accessibility-v1'));
      assert.equal(afterRevocation.desktop.accessibilityReady, false);
      assert.equal(afterRevocation.desktop.accessibilityPermission, 'denied');
      assert.equal((await post('/execute', inspect)).status, 400);
      assert.deepEqual(
        (await readFile(events, 'utf8'))
          .trim()
          .split('\n')
          .filter((op) => op !== 'status'),
        ['ax_inspect', 'ax_set_text'],
      );
    } finally {
      lines.close();
      child.stdin.end('close\n');
      await closed;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

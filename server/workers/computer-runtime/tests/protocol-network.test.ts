import test from 'node:test';

import assert from 'node:assert/strict';

import { mkdtemp, symlink, mkdir, rm, realpath } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import {
  LocalComputer,
  validateComputerAction,
  isPublicAddress,
  resolveBrowserTarget,
  createBrowserNetworkProxy,
  validateTakeoverInput,
  COMPUTER_WORKER_PROTOCOL,
} from '../../computer-worker/index.js';
import { resolveWorkspacePath } from '../computer-files.js';

import { createComputerWorker, isAuthorized } from '../../../../scripts/computer-worker.js';

import { createServer, request as httpRequest } from 'node:http';

test('manual input validation restricts coordinates, keys and protocol', () => {
  const leaseId = 'fixture-valid-lease-1234567890';
  for (const input of [
    { type: 'click', x: -1, y: 20 },
    { type: 'click', x: 1440, y: 20 },
    { type: 'key', key: 'Meta+R' },
    { type: 'scroll', deltaY: Infinity },
    { type: 'navigate', url: 'file:///etc/passwd' },
    { type: 'execute', text: 'code' },
  ])
    assert.throws(() => validateTakeoverInput({ leaseId, ...input }));
  assert.equal(validateTakeoverInput({ leaseId, type: 'key', key: 'Enter' }).key, 'Enter');
  assert.throws(() => validateComputerAction({ type: 'takeover_start' }));
});

test('public control-plane hostname is forbidden on every port despite fixture allowlist', async () => {
  const before = process.env.OPENBOT_PUBLIC_ORIGIN;
  process.env.OPENBOT_PUBLIC_ORIGIN = 'https://control.example.test';
  try {
    for (const target of [
      'https://control.example.test',
      'http://control.example.test:48080',
      'https://control.example.test.:8443',
    ]) {
      const url = new URL(target);
      await assert.rejects(resolveBrowserTarget(url, new Set([url.origin])), /控制台域名/);
    }
  } finally {
    if (before === undefined) delete process.env.OPENBOT_PUBLIC_ORIGIN;
    else process.env.OPENBOT_PUBLIC_ORIGIN = before;
  }
});

test('workspace blocks traversal, absolute paths and symlink escapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-computer-'));
  try {
    await mkdir(join(dir, 'workspace'));
    await symlink(tmpdir(), join(dir, 'workspace/escape'));
    await assert.rejects(resolveWorkspacePath(join(dir, 'workspace'), '../private'));
    await assert.rejects(resolveWorkspacePath(join(dir, 'workspace'), '/etc/passwd'));
    await assert.rejects(resolveWorkspacePath(join(dir, 'workspace'), 'escape/file', true));
    assert.equal(
      await resolveWorkspacePath(join(dir, 'workspace'), 'notes/today.txt', true),
      join(await realpath(dir), 'workspace/notes/today.txt'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file operations and terminal are real and bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-computer-'));
  try {
    const computer = new LocalComputer(dir);
    await computer.execute({ type: 'write_file', path: 'notes/a.txt', content: 'hello' });
    assert.equal(
      ((await computer.execute({ type: 'read_file', path: 'notes/a.txt' })) as any).content,
      'hello',
    );
    const result = (await computer.execute({ type: 'terminal_command', command: 'pwd' })) as any;
    assert.equal(await realpath(result.stdout.trim()), await realpath(dir));
    await assert.rejects(computer.execute({ type: 'terminal_command', command: 'ls; rm -rf /' }));
    assert.throws(() =>
      validateComputerAction({ type: 'browser_navigate', url: 'file:///etc/passwd' }),
    );
    await assert.rejects(computer.screenshot(), /尚未打开/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker rejects missing token and browser origins; supports authorized workspace reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-worker-'));
  const token = 'unit-test-secret-token-at-least-24';
  const { app, close } = createComputerWorker({ token, workspaceDir: dir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal(isAuthorized('Bearer wrong', token), false);
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/health`, {
          headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    const health = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);
    const state: any = await health.json();
    assert.equal(state.protocol, COMPUTER_WORKER_PROTOCOL);
    const result = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-OpenBot-Worker-Instance': state.instanceId,
        'X-OpenBot-Control-Origin': state.controlOrigin ?? 'none',
      },
      body: JSON.stringify({ type: 'list_files' }),
    });
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(((await result.json()) as any).entries));
  } finally {
    await close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser network rejects private IPs and control-plane allowlist entries', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(resolveBrowserTarget(new URL('http://127.0.0.1:3001/')));
  await assert.rejects(resolveBrowserTarget(new URL('http://[::1]:5173/')));
  await assert.rejects(resolveBrowserTarget(new URL('http://169.254.169.254/latest/meta-data')));
  const prior = process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
  process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = 'http://127.0.0.1:3001';
  try {
    await assert.rejects(createBrowserNetworkProxy(), /控制面/);
  } finally {
    if (prior === undefined) delete process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
    else process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = prior;
  }
});

test('egress proxy allows only explicit fixture and blocks redirected private destination', async () => {
  let blockedHits = 0;
  const forbidden = createServer((_req, res) => {
    blockedHits++;
    res.end('private');
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => forbidden.once('listening', r));
  const forbiddenUrl = `http://127.0.0.1:${(forbidden.address() as any).port}/secret`;
  const fixture = createServer((_req, res) => {
    res.writeHead(302, { Location: forbiddenUrl });
    res.end();
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => fixture.once('listening', r));
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as any).port}`;
  const prior = process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
  process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = fixtureUrl;
  const proxy = await createBrowserNetworkProxy();
  const throughProxy = (url: string) =>
    new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const request = httpRequest(
        proxy.url,
        { path: url, headers: { Host: new URL(url).host } },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  try {
    const initial = await throughProxy(fixtureUrl);
    assert.equal(initial.status, 302);
    const redirected = await throughProxy(initial.location!);
    assert.equal(redirected.status, 403);
    assert.equal(blockedHits, 0);
  } finally {
    if (prior === undefined) delete process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
    else process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = prior;
    await proxy.close();
    await Promise.all([
      new Promise<void>((r) => fixture.close(() => r())),
      new Promise<void>((r) => forbidden.close(() => r())),
    ]);
  }
});

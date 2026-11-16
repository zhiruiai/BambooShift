import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createComputerWorker } from '../http/worker.js';
import { WORKSPACE_SCOPE_HEADER } from '../../../../shared/computer-screens.js';
import { desktop, listen, until, exists, delay, token } from './isolated-shell.fixture.js';
import { pythonForSkillScript } from '../skill-script.js';

async function fixture(t: test.TestContext, hostShell = true) {
  const dir = await mkdtemp(join(tmpdir(), 'host-shell-http-'));
  const workspace = join(dir, 'workspace');
  const workspaceId = randomUUID();
  const worker = createComputerWorker({
    token,
    workspaceDir: workspace,
    workspaceScopeId: workspaceId,
    hostShell,
    desktopAdapter: desktop(),
  });
  const server = await listen(worker.app);
  const health = await (
    await fetch(server.base + '/health', {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-OpenBot-Worker-Instance': health.instanceId,
    'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
    [WORKSPACE_SCOPE_HEADER]: workspaceId,
  };
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(server.base + path, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  const command = (command: string, path = '.', id = randomUUID()) =>
    post('/execute', { type: 'local_shell', command, path }, { 'X-OpenBot-Action-Id': id });
  const script = (action: unknown, id = randomUUID()) =>
    post('/execute-skill-script', action, { 'X-OpenBot-Action-Id': id });
  const currentHealth = () => fetch(server.base + '/health', { headers });
  t.after(async () => {
    await worker.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { workspace, post, command, script, health, currentHealth };
}

test('host shell preflight directory failures do not poison the worker or consume future approvals', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const failure = await f.command('printf must-not-run > marker', 'missing-dir', id);
  assert.equal(failure.status, 400);
  assert.equal(await exists(join(f.workspace, 'marker')), false);
  const health = await f.currentHealth();
  assert.equal(health.status, 200);
  assert.ok((await health.json()).capabilities.includes('local-shell-v1'));
  const cleanup = await f.post('/shell/cancel', { id });
  assert.equal(cleanup.status, 200);
  assert.equal((await cleanup.json()).stopped, true);
  const next = await f.command('printf next');
  assert.equal(next.status, 200);
  assert.equal((await next.json()).stdout, 'next');
  assert.equal((await f.command('printf must-not-replay > marker', '.', id)).status, 400);
  assert.equal(await exists(join(f.workspace, 'marker')), false);
});

test('host shell requires opt-in, server token, current workspace and a unique action identity', async (t) => {
  const disabled = await fixture(t, false);
  assert.equal(disabled.health.capabilities.includes('local-shell-v1'), false);
  assert.equal((await disabled.command('printf blocked > marker')).status, 400);
  assert.equal(await exists(join(disabled.workspace, 'marker')), false);
  const enabled = await fixture(t);
  const action = { type: 'local_shell', command: 'printf blocked > marker' };
  assert.equal((await enabled.post('/execute', action)).status, 400);
  assert.equal(
    (
      await enabled.post('/execute', action, {
        'X-OpenBot-Action-Id': randomUUID(),
        Authorization: 'Bearer invalid',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await enabled.post('/execute', action, {
        'X-OpenBot-Action-Id': randomUUID(),
        [WORKSPACE_SCOPE_HEADER]: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await enabled.post('/execute', action, {
        'X-OpenBot-Action-Id': randomUUID(),
        Origin: 'https://example.invalid',
      })
    ).status,
    403,
  );
  assert.equal(await exists(join(enabled.workspace, 'marker')), false);
  assert.equal((await enabled.command('printf permitted')).status, 200);
});

test('host shell cancellation waits for the tracked process and rejects delayed replays', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const pending = f.command('printf ready > started; sleep 1; printf unsafe > late', '.', id);
  await until(() => exists(join(f.workspace, 'started')));
  const stopped = await f.post('/shell/cancel', { id });
  const receipt = await stopped.json();
  assert.equal(
    stopped.status,
    200,
    JSON.stringify({
      receipt,
      ...(stopped.status !== 200 && { execution: await (await pending).clone().json() }),
    }),
  );
  assert.equal(receipt.stopped, true);
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal((await result.json()).cancelled, true);
  await delay(1100);
  assert.equal(await exists(join(f.workspace, 'late')), false);
  assert.equal((await f.command('printf late > replayed', '.', id)).status, 400);
  const beforeDispatch = randomUUID();
  assert.equal((await f.post('/shell/cancel', { id: beforeDispatch })).status, 200);
  assert.equal((await f.command('printf late > replayed', '.', beforeDispatch)).status, 400);
  assert.equal(await exists(join(f.workspace, 'replayed')), false);
  assert.equal((await f.command('printf safe')).status, 200);
});

test('cancel and takeover confirm cleanup after a shell exits with redirected background children', async (t) => {
  const f = await fixture(t);
  const groupFile = join(f.workspace, 'process-group');
  try {
    const id = randomUUID();
    const response = await f.command(
      [
        'printf %s "$$" > process-group;',
        '(trap "" TERM; printf ready > background-ready; sleep 1; printf unsafe > late)',
        '</dev/null >/dev/null 2>&1 &',
        'while [ ! -f background-ready ]; do sleep 0.01; done;',
        'printf complete',
      ].join(' '),
      '.',
      id,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'complete');
    assert.equal(result.cancelled, false);
    const cancelled = await f.post('/shell/cancel', { id });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).stopped, true);
    assert.equal((await f.post('/surface', { surface: 'desktop', confirm: true })).status, 200);
    const takeover = await f.post('/takeover/start', {});
    assert.equal(takeover.status, 200);
    const lease = await takeover.json();
    assert.equal(lease.active, true);
    const group = Number(await readFile(groupFile, 'utf8'));
    assert.ok(Number.isSafeInteger(group) && group > 1);
    assert.throws(
      () => process.kill(-group, 0),
      { code: 'ESRCH' },
      'Stopped and takeover acknowledgements require the original process group to be gone',
    );
    await delay(1100);
    assert.equal(await exists(join(f.workspace, 'late')), false);
    assert.equal((await f.post('/takeover/end', { leaseId: lease.leaseId })).status, 200);
    assert.equal((await f.currentHealth()).status, 200);
    assert.equal((await f.command('printf safe')).status, 200);
  } finally {
    const group = Number(await readFile(groupFile, 'utf8').catch(() => '0'));
    if (Number.isSafeInteger(group) && group > 1) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
});

test('host shell remains blocked during private human takeover and can resume after release', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('/surface', { surface: 'desktop', confirm: true })).status, 200);
  const takeover = await f.post('/takeover/start', {});
  assert.equal(takeover.status, 200);
  const { leaseId } = await takeover.json();
  assert.equal((await f.command('printf blocked > marker')).status, 400);
  assert.equal(await exists(join(f.workspace, 'marker')), false);
  assert.equal((await f.post('/takeover/end', { leaseId })).status, 200);
  const resumed = await f.command('printf resumed');
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).stdout, 'resumed');
});

function skillScript(
  path: string,
  args: string[],
  source: Record<string, string>,
  input?: { name: string; content: string },
) {
  const root = 'spreadsheet-review';
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const files = Object.entries({ 'SKILL.md': '# Fixture', ...source }).map(([path, content]) => {
    const bytes = Buffer.from(content);
    return { path, base64: bytes.toString('base64'), sha256: digest(bytes) };
  });
  const manifest = `bambooshift-skill-package-v1\n${root}\n${[...files]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((entry) => `${entry.path}\0${entry.sha256}\n`)
    .join('')}`;
  return {
    type: 'local_skill_script',
    path,
    args,
    package: { root, manifestSha256: digest(Buffer.from(manifest)), files },
    ...(input && {
      input: {
        name: input.name,
        base64: Buffer.from(input.content).toString('base64'),
        sha256: digest(Buffer.from(input.content)),
      },
    }),
  };
}

test('the managed Worker runs the actual bundled CSV checker with the approved CSV', async (t) => {
  if (!(await pythonForSkillScript())) return t.skip('Python 3 is unavailable');
  const f = await fixture(t);
  assert.ok(f.health.capabilities.includes('local-skill-script-v1'));
  const catalog = JSON.parse(
    await readFile(
      new URL('../../../../shared/skill-workflow-resources.json', import.meta.url),
      'utf8',
    ),
  );
  const action = skillScript(
    'scripts/profile_csv.py',
    ['__SKILL_INPUT__', '--key', 'id'],
    { ...catalog['spreadsheet-review'].files, 'assets/large.txt': 'x'.repeat(220 * 1024) },
    { name: 'Ledger review.csv', content: 'id,amount\na,4\na,\nb,8\nill-shaped\n' },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(action)) > 256 * 1024);
  const id = randomUUID();
  const response = await f.script(action, id);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.cancelled, false);
  assert.deepEqual(JSON.parse(result.stdout), {
    rows: 4,
    wrong_width_rows: 1,
    blank_cells_by_column: { id: 0, amount: 1 },
    key: 'id',
    duplicate_key_rows: 1,
  });
  assert.equal((await f.script(action, id)).status, 400);
  assert.equal((await (await f.post('/shell/cancel', { id })).json()).stopped, true);
});

test('skill script dispatch validates bundle bytes and stays off the generic route', async (t) => {
  const disabled = await fixture(t, false);
  const f = await fixture(t);
  const source = { 'scripts/check.mjs': 'console.log("reviewed");' };
  const action = skillScript('scripts/check.mjs', [], source);
  assert.ok(!disabled.health.capabilities.includes('local-skill-script-v1'));
  assert.equal((await disabled.script(action)).status, 400);
  assert.equal((await f.post('/execute', action)).status, 400);
  assert.equal((await f.post('/execute-skill-script', action)).status, 400);
  assert.equal(
    (
      await f.post('/execute-skill-script', action, {
        [WORKSPACE_SCOPE_HEADER]: randomUUID(),
        'X-OpenBot-Action-Id': randomUUID(),
      })
    ).status,
    409,
  );

  const changedFile = structuredClone(action);
  changedFile.package.files[1].base64 = Buffer.from('console.log("changed");').toString('base64');
  const changedManifest = structuredClone(action);
  changedManifest.package.manifestSha256 = '0'.repeat(64);
  const escaped = skillScript('scripts/check.mjs', [], { ...source, '../escape': 'no' });
  const colliding = skillScript('scripts/check.mjs', [], { ...source, 'SCRIPTS/CHECK.MJS': 'no' });
  for (const invalid of [
    changedFile,
    changedManifest,
    escaped,
    colliding,
    {
      ...action,
      args: ['__SKILL_INPUT__'],
    },
  ]) {
    const response = await f.script(invalid);
    assert.equal(response.status, 400, await response.text());
  }
  assert.equal((await f.currentHealth()).status, 200);
  assert.equal((await (await f.script(action)).json()).stdout.trim(), 'reviewed');
});

test('skill script gets literal argv, private sibling input, and cleanup after exiting', async (t) => {
  const f = await fixture(t);
  const literal = '$(printf replaced); `echo nope` | "quoted"';
  const action = skillScript(
    'scripts/check.mjs',
    ['__SKILL_INPUT__', literal],
    {
      'scripts/check.mjs': `
      import {readFileSync, statSync} from 'node:fs';
      console.log(JSON.stringify({cwd: process.cwd(), argv: process.argv.slice(2),
        input: process.env.BAMBOOSHIFT_SKILL_INPUT,
        mode: statSync(process.argv[2]).mode & 0o777,
        csv: readFileSync(process.argv[2], 'utf8'),
        resource: readFileSync('references/checklist.md', 'utf8')}));`,
      'references/checklist.md': 'approved reference',
    },
    { name: 'synthetic.csv', content: 'id\na\n' },
  );
  const response = await f.script(action);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const reviewed = JSON.parse(result.stdout);
  assert.deepEqual(reviewed.argv, [reviewed.input, literal]);
  assert.equal(reviewed.input, join(dirname(reviewed.cwd), '.input', 'synthetic.csv'));
  assert.equal(reviewed.mode, 0o600);
  assert.equal(reviewed.csv, 'id\na\n');
  assert.equal(reviewed.resource, 'approved reference');
  await assert.rejects(access(dirname(reviewed.cwd)), { code: 'ENOENT' });
});

test('cancelling a skill script removes its staged package before acknowledging', async (t) => {
  const f = await fixture(t);
  await mkdir(f.workspace, { recursive: true });
  const ready = join(f.workspace, 'ready');
  const late = join(f.workspace, 'late');
  const action = skillScript('scripts/check.mjs', [ready, late], {
    'scripts/check.mjs': `
      import {writeFileSync} from 'node:fs';
      writeFileSync(process.argv[2], process.cwd());
      setTimeout(() => writeFileSync(process.argv[3], 'late'), 1000);`,
  });
  const id = randomUUID();
  const pending = f.script(action, id);
  await until(() => exists(ready));
  const stage = dirname(await readFile(ready, 'utf8'));
  await access(stage);
  const cancel = await f.post('/shell/cancel', { id });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).stopped, true);
  assert.equal((await (await pending).json()).cancelled, true);
  await assert.rejects(access(stage), { code: 'ENOENT' });
  await delay(1100);
  assert.equal(await exists(late), false);
  assert.equal((await f.script(action, id)).status, 400);
});

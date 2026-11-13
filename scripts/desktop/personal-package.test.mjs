import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  argumentsForCheck,
  inspectPersonalPackage,
  packageHashes,
  digest,
} from './personal-package-inputs.mjs';
import { fixtures, modelReply, startPersonalModel } from './personal-package-model.mjs';
import { runPersonalProbe } from './personal-package-process.mjs';

const supported = ['darwin', 'linux'].includes(process.platform);

test('the CLI accepts only an explicit package and cannot select a profile, model or host control', () => {
  assert.deepEqual(argumentsForCheck(['--help']), { help: true });
  assert.ok(argumentsForCheck(['--resources', './synthetic']).resources.endsWith('/synthetic'));
  for (const args of [
    [],
    ['--resources'],
    ['--resources', '--host-control'],
    ['--resources', '.', '--host-control'],
    ['--resources', '.', '--profile', '/existing'],
    ['--resources', '.', '--model', 'https://example.test'],
    ['--host-control', 'true'],
  ])
    assert.throws(() => argumentsForCheck(args));
});

async function packageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bambooshift-package-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, 'resources'),
    runtime = join(resources, 'bambooshift-runtime');
  await mkdir(join(runtime, 'runtime/packages/pi-worker'), { recursive: true });
  await mkdir(join(runtime, 'bin'));
  const manifest = {
    version: 1,
    platform: process.platform,
    architecture: process.arch,
    server: 'openbot-backend',
    node: 'bin/node',
    runtime: 'runtime',
  };
  const save = () => writeFile(join(runtime, 'desktop-runtime.json'), JSON.stringify(manifest));
  await save();
  for (const path of [
    join(resources, 'app.asar'),
    join(runtime, 'openbot-backend'),
    join(runtime, 'bin/node'),
    join(runtime, 'runtime/packages/pi-worker/index.mjs'),
  ])
    await writeFile(path, 'synthetic nonexecutable fixture');
  return { root, resources, runtime, manifest, save };
}

test(
  'missing, mismatched and redirected runtime inputs fail without development-tree fallback',
  { skip: !supported },
  async (t) => {
    const f = await packageFixture(t);
    const input = await inspectPersonalPackage(f.resources);
    const original = await packageHashes(input.paths);
    await writeFile(input.paths.pi, 'changed synthetic worker');
    assert.notEqual((await packageHashes(input.paths)).pi, original.pi);
    f.manifest.architecture = process.arch === 'arm64' ? 'x64' : 'arm64';
    await f.save();
    await assert.rejects(inspectPersonalPackage(f.resources), /match/);
    f.manifest.architecture = process.arch;
    f.manifest.node = '../../outside';
    await f.save();
    await assert.rejects(inspectPersonalPackage(f.resources), /match/);
    f.manifest.node = 'bin/node';
    await f.save();
    await rm(input.paths.node);
    await assert.rejects(inspectPersonalPackage(f.resources));
    await writeFile(join(f.root, 'outside-node'), 'must not execute');
    await symlink(join(f.root, 'outside-node'), input.paths.node);
    await assert.rejects(inspectPersonalPackage(f.resources), /invalid|escaping/);
  },
);

test('an unsupported runtime target is rejected before executable launch', async (t) => {
  const f = await packageFixture(t);
  f.manifest.platform = 'win32';
  await f.save();
  await assert.rejects(inspectPersonalPackage(f.resources), /match/);
});

const request = (fixture, extra = []) => ({
  stream: true,
  messages: [{ role: 'user', content: fixture.prompt }, ...extra],
  tools: ['workspace_write', 'workspace_deliver'].map((name) => ({
    type: 'function',
    function: { name },
  })),
});
const receipt = (name, value) => ({ role: 'tool', name, content: JSON.stringify(value) });

test('the model requires real write and delivery receipts before it reports success', () => {
  const fixture = fixtures[0],
    events = [];
  const write = modelReply(request(fixture), events);
  assert.deepEqual(JSON.parse(write.tool_calls[0].function.arguments), {
    path: fixture.path,
    content: fixture.content,
  });
  assert.throws(() =>
    modelReply(request(fixture, [receipt('workspace_write', { error: 'no file' })]), events),
  );
  assert.equal(events.length, 1);
  const deliver = modelReply(
    request(fixture, [receipt('workspace_write', { sha256: digest(fixture.content) })]),
    events,
  );
  assert.equal(deliver.tool_calls[0].function.name, 'workspace_deliver');
  assert.equal(
    JSON.parse(deliver.tool_calls[0].function.arguments).expectedSha256,
    digest(fixture.content),
  );
  assert.throws(() =>
    modelReply(request(fixture, [receipt('workspace_deliver', { delivered: false })]), events),
  );
  assert.equal(
    modelReply(request(fixture, [receipt('workspace_deliver', { delivered: true })]), events)
      .content,
    fixture.answer,
  );
  assert.throws(
    () => modelReply(request(fixture), events),
    'A retry must not silently overwrite a fixture.',
  );
});

test('unexpected prompts, missing tools and tool-only requests cannot fabricate acceptance', () => {
  assert.throws(() => modelReply(request({ prompt: 'unrelated task' }), []));
  const missing = request(fixtures[0]);
  missing.tools = [];
  assert.throws(() => modelReply(missing, []));
  assert.throws(() =>
    modelReply(request(fixtures[0], [receipt('workspace_deliver', { delivered: true })]), []),
  );
});

test('restored conversation history cannot choose the old task fixture', () => {
  const body = request(fixtures[1]);
  body.messages[0].content = JSON.stringify({
    content: fixtures[1].prompt,
    history: [{ role: 'user', content: fixtures[0].prompt }],
  });
  const reply = modelReply(body, []);
  assert.equal(JSON.parse(reply.tool_calls[0].function.arguments).path, fixtures[1].path);
});

test('the real loopback model accepts the streaming transport and rejects unrelated endpoints', async () => {
  const model = await startPersonalModel();
  try {
    const response = await fetch(model.settings.baseUrl + '/chat/completions', {
      method: 'POST',
      body: JSON.stringify(request(fixtures[0])),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /event-stream/);
    assert.match(await response.text(), /workspace_write/);
    assert.equal((await fetch(model.settings.baseUrl + '/unexpected')).status, 400);
    assert.equal(model.failures.length, 1);
  } finally {
    await model.close();
  }
});

test(
  'the outer deadline kills an unresponsive probe and its registered detached backend',
  { skip: !supported },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bambooshift-probe-stop-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const code = `
    const {spawn}=require('node:child_process');
    const {writeFileSync}=require('node:fs');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
    process.on('message',message=>{
      if(message.type==='managed-group-confirmed')writeFileSync('registered',String(child.pid));
    });
    process.send({type:'managed-group',pid:child.pid});setInterval(()=>{},1000);
  `;
    const started = Date.now();
    await assert.rejects(
      runPersonalProbe(
        process.execPath,
        ['-e', code],
        {
          cwd: directory,
          env: { PATH: '/usr/bin:/bin' },
        },
        { timeoutMs: 1000, graceMs: 100 },
      ),
      /deadline/,
    );
    assert.ok(Date.now() - started < 6000);
    const { readFile } = await import('node:fs/promises');
    const pid = Number(await readFile(join(directory, 'registered'), 'utf8'));
    assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  },
);

test(
  'spawn failures and raw child errors never expose process paths or output',
  { skip: !supported },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bambooshift-probe-errors-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await assert.rejects(
      runPersonalProbe(join(directory, 'not-an-executable'), [], { cwd: directory }),
      { message: 'The packaged Node runtime could not start.' },
    );
    await assert.rejects(
      runPersonalProbe(
        process.execPath,
        ['-e', 'console.error("synthetic-private-path-do-not-print");process.exit(1)'],
        { cwd: directory },
      ),
      { message: 'The packaged acceptance process failed.' },
    );
  },
);

test(
  'an exited probe cannot leave an inherited process-group child behind',
  { skip: !supported },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bambooshift-probe-inherited-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const code = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    require('node:fs').writeFileSync('child',String(child.pid));
    process.stdout.write('{"passed":true}');process.exit(0);
  `;
    assert.deepEqual(await runPersonalProbe(process.execPath, ['-e', code], { cwd: directory }), {
      passed: true,
    });
    const { readFile } = await import('node:fs/promises');
    const pid = Number(await readFile(join(directory, 'child'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);

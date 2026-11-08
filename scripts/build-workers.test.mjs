import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { buildWorkers } from './build-workers.mjs';
import { productionLock } from './worker-runtime-lock.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function child(runtime, worker) {
  const process = spawn(
    globalThis.process.execPath,
    [join(runtime, 'packages', worker, 'index.mjs')],
    {
      cwd: runtime,
      env: { LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const done = once(process, 'close');
  const lines = createInterface({ input: process.stdout });
  const events = [];
  lines.on('line', (line) => {
    events.push(JSON.parse(line));
  });
  const timer = setTimeout(() => process.kill('SIGKILL'), 15000);
  void done.then(() => {
    clearTimeout(timer);
    lines.close();
  });
  const until = async (predicate) => {
    for (let n = 0; n < 1000; n++) {
      const value = events.find(predicate);
      if (value) return value;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('Released worker did not return its expected protocol event.');
  };
  return {
    process,
    done,
    until,
    send(value) {
      process.stdin.write(JSON.stringify(value) + '\n');
    },
    async close() {
      process.stdin.end();
      await done;
      clearTimeout(timer);
      lines.close();
    },
  };
}

test('released workers contain only audited execution helpers and an exact production-only dependency graph', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-worker-build-'));
  try {
    const summary = await buildWorkers(directory);
    assert.equal(summary.workers.length, 4);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.dependencies.tsx, undefined);
    assert.ok(Object.values(manifest.dependencies).every((v) => /^\d+\.\d+\.\d+/.test(v)));
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue;
      assert.equal(entry.dev, undefined);
      assert.ok(entry.integrity);
      assert.ok(!/node_modules\/(?:tsx|typescript|react|react-dom|esbuild)$/.test(path));
    }
    for (const worker of summary.workers) {
      assert.match(worker.sha256, /^[a-f0-9]{64}$/);
      assert.ok(worker.inputs.every((input) => /^(?:server\/workers|shared)\//.test(input)));
      assert.deepEqual(await readdir(join(directory, 'packages', worker.worker)), ['index.mjs']);
    }
    assert.ok(!summary.workers.some((w) => w.inputs.some((p) => p.endsWith('run.mjs'))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('all four compiled workers start without a tsx loader, source entries, ambient secrets or a business database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-worker-execution-'));
  const running = [];
  try {
    await buildWorkers(directory);
    await symlink(resolve(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const doc = child(directory, 'document-worker');
    running.push(doc);
    doc.send({
      version: 1,
      name: 'synthetic.csv',
      data: Buffer.from('名称,数量\n合成,3\n').toString('base64'),
    });
    doc.process.stdin.end();
    const parsed = await doc.until((e) => e.ok === true);
    assert.equal(parsed.result.text, '名称,数量\n合成,3\n');
    await doc.close();
    const pi = child(directory, 'pi-worker');
    running.push(pi);
    pi.send({ type: 'invalid', runId: 'synthetic' });
    assert.equal((await pi.until((e) => e.type === 'protocol_error')).code, 'INVALID_COMMAND');
    await pi.close();
    const mcp = child(directory, 'mcp-worker');
    running.push(mcp);
    mcp.send({ type: 'operation', op: 'invalid' });
    assert.equal((await mcp.until((e) => e.type === 'result')).ok, false);
    await mcp.close();
    const computer = child(directory, 'computer-worker');
    running.push(computer);
    computer.send({
      workspace: join(directory, 'synthetic-workspace'),
      workspaceId: '11111111-1111-4111-8111-111111111111',
    });
    const ready = await computer.until((e) => e.ready === true);
    const health = await fetch(ready.url + '/health', {
      headers: { Authorization: `Bearer ${ready.token}` },
    });
    assert.equal(health.status, 200);
    const state = await health.json();
    assert.equal(state.protocol, 'openbot-computer-v2');
    await computer.close();
  } finally {
    for (const worker of running) {
      worker.process.kill('SIGKILL');
      await worker.done;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime dependency projection rejects unpinned or private dependencies', () => {
  const entry = {
    version: '1.0.0',
    integrity: 'sha512-synthetic',
    resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
  };
  const root = { version: '0.0.42' };
  const lock = { lockfileVersion: 3, packages: { '': root, 'node_modules/example': entry } };
  const { manifest } = productionLock(lock, ['example']);
  assert.equal(manifest.version, root.version);
  assert.equal(manifest.dependencies.example, '1.0.0');
  assert.throws(
    () =>
      productionLock(
        {
          ...lock,
          packages: { '': root, 'node_modules/example': { ...entry, integrity: undefined } },
        },
        ['example'],
      ),
    /pinned/,
  );
  assert.throws(
    () =>
      productionLock(
        {
          ...lock,
          packages: {
            '': root,
            'node_modules/example': {
              ...entry,
              resolved: 'https://synthetic:password@example.test/package.tgz',
            },
          },
        },
        ['example'],
      ),
    /private/,
  );
  assert.throws(
    () =>
      productionLock(
        {
          ...lock,
          packages: {
            '': root,
            'node_modules/example': {
              ...entry,
              resolved: 'https://registry.npmjs.org/example.tgz?token=synthetic',
            },
          },
        },
        ['example'],
      ),
    /private/,
  );
});

test('the compiled Pi bundle completes a real SDK tool round trip against a local synthetic model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-released-pi-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let data = '';
    for await (const part of request) data += part;
    requests.push(JSON.parse(data));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: 'synthetic-release-model',
          object: 'chat.completion.chunk',
          model: 'fixture',
          created: 1,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (requests.length === 1) {
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'synthetic-native-call',
            type: 'function',
            function: { name: 'read_approved_note', arguments: '{}' },
          },
        ],
      });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: 'Synthetic note received.' });
      chunk({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  let pi;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await buildWorkers(directory);
    await symlink(resolve(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    pi = child(directory, 'pi-worker');
    pi.send({
      type: 'start',
      version: 1,
      runId: 'synthetic-release-run',
      cwd: directory,
      prompt: 'Read the synthetic approved note.',
      systemPrompt: 'Only use the provided tool.',
      profile: {
        provider: 'synthetic-release',
        model: 'fixture',
        apiKey: 'synthetic-key',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      },
      tools: [
        {
          name: 'read_approved_note',
          description: 'Read one host-approved note.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
    const call = await pi.until((event) => event.type === 'tool_call');
    assert.equal(call.name, 'read_approved_note');
    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name),
      ['read_approved_note'],
    );
    pi.send({
      type: 'tool_result',
      runId: call.runId,
      callId: call.callId,
      result: { content: [{ type: 'text', text: 'A synthetic host-approved note.' }] },
    });
    assert.equal((await pi.until((event) => event.type === 'settled')).status, 'completed');
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1]).includes('A synthetic host-approved note.'));
    await pi.close();
  } finally {
    if (pi) {
      pi.process.kill('SIGKILL');
      await pi.done;
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});

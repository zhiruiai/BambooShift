import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkOperationsBoundary, packageOrigins } from './backend-package-boundaries.mjs';

async function until(check, deadline = 20000) {
  const end = Date.now() + deadline;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw Error('The packaged service did not reach its expected state.');
}
function frame(response, delta, reason) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [value, finish_reason] of [
    [delta, null],
    [{}, reason],
  ])
    response.write(
      `data: ${JSON.stringify({
        id: 'synthetic-package-model',
        object: 'chat.completion.chunk',
        model: 'fixture',
        created: 1,
        choices: [{ index: 0, delta: value, finish_reason }],
      })}\n\n`,
    );
  response.end('data: [DONE]\n\n');
}

async function checkDocumentCodec(runtime, image) {
  const worker = spawn(process.execPath, [join(runtime, 'packages/document-worker/index.mjs')], {
    cwd: runtime,
    env: { LANG: 'en_US.UTF-8' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const done = once(worker, 'close');
  const timer = setTimeout(() => worker.kill('SIGKILL'), 10000);
  let output = '';
  worker.stdout.on('data', (bytes) => {
    output += bytes;
    if (output.length > 12 * 1024 * 1024) worker.kill('SIGKILL');
  });
  worker.stdin.end(
    JSON.stringify({
      version: 1,
      name: 'synthetic-public-icon.png',
      data: image.toString('base64'),
    }),
  );
  try {
    const [code] = await done;
    assert.equal(code, 0);
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.result.kind, 'image');
    assert.equal(result.result.width, 192);
    assert.equal(result.result.height, 192);
    assert.equal(result.result.mimeType, 'image/png');
  } finally {
    clearTimeout(timer);
  }
}

export async function checkBackendPackage(packagePath) {
  const artifact = resolve(packagePath),
    runtime = join(artifact, 'runtime');
  const directory = await mkdtemp(join(tmpdir(), 'openbot-package-acceptance-'));
  const calls = [];
  const model = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let content = '';
    for await (const part of request) content += part;
    const body = JSON.parse(content);
    calls.push(body);
    if (calls.length === 1)
      frame(
        response,
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'synthetic-package-memory',
              type: 'function',
              function: {
                name: 'remember',
                arguments: JSON.stringify({
                  content: 'Synthetic package preference',
                  category: 'preference',
                }),
              },
            },
          ],
        },
        'tool_calls',
      );
    else
      frame(
        response,
        { role: 'assistant', content: 'The packaged Rust host saved the synthetic preference.' },
        'stop',
      );
  });
  let child, completed, lines, spawnError;
  let output = '',
    ready;
  try {
    assert.equal((await lstat(join(runtime, 'node_modules'))).isSymbolicLink(), false);
    for (const name of ['pi', 'mcp', 'computer', 'document'])
      assert.ok((await lstat(join(runtime, `packages/${name}-worker/index.mjs`))).isFile());
    await assert.rejects(lstat(join(runtime, 'node_modules/tsx')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(runtime, 'server')), { code: 'ENOENT' });
    const publicIcon = await readFile(join(runtime, 'dist/icon-192.png'));
    await readFile(join(runtime, 'operations-dist/index.html'));
    await checkDocumentCodec(runtime, publicIcon);
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const config = join(directory, 'server.private.json');
    await writeFile(
      config,
      JSON.stringify({
        dataDir: join(directory, 'data'),
        bind: '127.0.0.1:0',
        operations: { bind: '127.0.0.1:0' },
        runtimeDir: runtime,
        nodeBinary: process.execPath,
      }),
      { mode: 0o600 },
    );
    const executable = join(
      artifact,
      `openbot-backend${process.platform === 'win32' ? '.exe' : ''}`,
    );
    child = spawn(executable, ['--config', config], {
      cwd: artifact,
      env: { LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    completed = once(child, 'close');
    void completed.catch((error) => {
      spawnError = error;
    });
    child.stderr.on('data', (bytes) => {
      output = (output + bytes.toString()).slice(-8000);
    });
    lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const event = JSON.parse(line);
      if (event.type === 'openbot:ready') ready = event;
    });
    await until(() => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw Error(`Packaged service exited: ${output}`);
      return ready;
    });
    const origins = packageOrigins(ready);
    const origin = origins.product;
    const api = async (path, { method = 'GET', body, cookie, user } = {}) => {
      const response = await fetch(origin + path, {
        method,
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(user ? { 'X-OpenBot-Expected-User': user } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        headers: response.headers,
        value: response.status === 204 ? null : await response.json(),
      };
    };
    assert.equal((await api('/api/health')).value.backend, 'rust');
    const page = await fetch(origin + '/', { signal: AbortSignal.timeout(10000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root">/);
    const manifest = await fetch(origin + '/manifest.webmanifest', {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
    const offline = await fetch(origin + '/offline.js', { signal: AbortSignal.timeout(10000) });
    assert.equal(offline.status, 200);
    assert.ok((await offline.text()).length > 0);
    const register = await api('/api/account/register', {
      method: 'POST',
      body: {
        email: 'packaged-user@example.test',
        name: 'Synthetic package user',
        password: 'synthetic-password-42',
        kind: 'personal',
      },
    });
    assert.equal(register.status, 201, JSON.stringify(register.value));
    const cookie = register.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const user = register.value.user.id,
      workspace = register.value.workspaceId;
    const operations = await checkOperationsBoundary(origins, {
      cookie,
      workspace,
      email: 'packaged-user@example.test',
      password: 'synthetic-password-42',
    });
    const path = `/api/workspaces/${workspace}`,
      context = { cookie, user };
    const bootstrap = await api(path + '/bootstrap', context);
    assert.equal(bootstrap.status, 200);
    const conversation = bootstrap.value.conversations[0],
      agent = bootstrap.value.agents[0];
    assert.equal((await api(path + '/bootstrap', { cookie, user: randomUUID() })).status, 403);
    const sourceResponse = await fetch(origin + path + '/bot-avatars/sources', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-OpenBot-Expected-User': user, 'Content-Type': 'image/png' },
      body: publicIcon,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const source = await sourceResponse.json();
    assert.equal(sourceResponse.status, 201, JSON.stringify(source));
    const cropped = await api(path + '/bot-avatars', {
      ...context,
      method: 'POST',
      body: {
        sourceId: source.id,
        crop: { left: 0, top: 0, size: Math.min(source.width, source.height) },
      },
    });
    assert.equal(cropped.status, 201, JSON.stringify(cropped.value));
    assert.equal(cropped.value.width, 512);
    assert.equal(cropped.value.height, 512);
    const avatar = await fetch(origin + path + '/bot-avatars/' + cropped.value.id, {
      headers: { Cookie: cookie, 'X-OpenBot-Expected-User': user },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(avatar.status, 200);
    assert.match(avatar.headers.get('content-type'), /^image\/webp/);
    const avatarBytes = Buffer.from(await avatar.arrayBuffer());
    assert.equal(avatarBytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal(avatarBytes.subarray(8, 12).toString(), 'WEBP');
    assert.equal(
      (await api(path + '/bot-avatars/sources/' + source.id, { ...context, method: 'DELETE' }))
        .status,
      204,
    );
    const settings = await api(path + '/settings', {
      ...context,
      method: 'PUT',
      body: {
        provider: 'synthetic-package',
        model: 'fixture',
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        apiKey: 'SYNTHETIC_PACKAGE_MODEL_KEY',
      },
    });
    assert.equal(settings.status, 200, JSON.stringify(settings.value));
    const input = {
      content: 'Remember only this synthetic package preference.',
      agentId: agent.id,
      clientId: randomUUID(),
      mode: 'followUp',
    };
    const messagePath = path + `/conversations/${conversation.id}/messages`;
    const accepted = await api(messagePath, { ...context, method: 'POST', body: input });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
    const final = await until(async () => {
      const response = await api(path + '/bootstrap', context);
      assert.equal(response.status, 200);
      const messages = response.value.messages;
      if (messages.some((message) => message.role === 'assistant' && message.status === 'error'))
        throw Error('Packaged Pi execution failed: ' + JSON.stringify(messages));
      return messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'done' &&
          message.content === 'The packaged Rust host saved the synthetic preference.',
      )
        ? response.value
        : undefined;
    });
    assert.equal(calls.length, 2);
    assert.ok(
      final.memories.some(
        (memory) =>
          memory.agentId === agent.id && memory.content === 'Synthetic package preference',
      ),
    );
    assert.equal(JSON.stringify(final).includes('SYNTHETIC_PACKAGE_MODEL_KEY'), false);
    const repeated = await api(messagePath, { ...context, method: 'POST', body: input });
    assert.equal(repeated.status, 202);
    assert.equal(repeated.value.message.id, accepted.value.message.id);
    assert.equal(calls.length, 2);
    assert.equal(
      (await api('/api/account/logout', { cookie, method: 'POST', body: {} })).status,
      200,
    );
    assert.equal((await api(path + '/bootstrap', context)).status, 401);
    child.kill('SIGTERM');
    const [code, signal] = await Promise.race([
      completed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error('Packaged service did not shut down cleanly.')),
          10000,
        ).unref(),
      ),
    ]);
    assert.equal(code, 0);
    assert.equal(signal, null);
    return {
      version: 1,
      packageProfile: JSON.parse(await readFile(join(artifact, 'package-manifest.json'), 'utf8'))
        .profile,
      health: true,
      publicUi: true,
      ...operations,
      nativeImageWorkerCrop: true,
      productionSharpCodec: true,
      registration: true,
      privateWorkspace: true,
      expectedUserMismatchRejected: true,
      actualPiModelRequests: calls.length,
      rustOwnedMemoryWrite: true,
      duplicateInputNotReplayed: true,
      logoutRevocation: true,
      gracefulShutdown: true,
      dependencies: 'clean production npm installation',
      data: 'temporary synthetic account and local mock model; removed after validation',
      productionCutover: false,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (completed) await completed.catch(() => {});
    lines?.close();
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Usage: check-backend-package.mjs package-directory');
  console.log(JSON.stringify(await checkBackendPackage(process.argv[2])));
}

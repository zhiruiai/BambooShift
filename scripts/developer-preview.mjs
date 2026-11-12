import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { launchBackend } from './backend-launch.mjs';
import { buildWorkers } from './build-workers.mjs';
import { cargo, root, rustBinary } from './rust-toolchain.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--check'))
  throw Error('Usage: npm run dev:preview [-- --check]');
const check = args[0] === '--check';
const prompt = 'Deliver the sample launch checklist.';
const document =
  '# Launch checklist\n\n- [ ] Riley reviews the preview.\n- [ ] Morgan approves launch.\n';
const documentHash = createHash('sha256').update(document).digest('hex');
const done = 'The sample launch checklist is ready.';
const modelKey = randomBytes(24).toString('hex');

function call(id, name, args) {
  return {
    tool_calls: [
      { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

function sampleReply({ messages, tools = [] }) {
  const inputIndex = messages.findLastIndex((message) => message.role === 'user');
  const input = messages[inputIndex]?.content;
  if (!JSON.stringify(input ?? '').includes(prompt))
    return { content: 'This local preview uses scripted replies. Try: ' + prompt };
  const result = messages.slice(inputIndex + 1).findLast((message) => message.role === 'tool');
  const id = result?.tool_call_id;
  if (typeof id === 'string' && id.startsWith('preview-deliver-')) {
    const delivered = JSON.parse(result.content);
    return { content: delivered.fileId ? done : 'The sample file could not be delivered.' };
  }
  if (typeof id === 'string' && id.startsWith('preview-write-')) {
    const { saved, sha256 } = JSON.parse(result.content);
    if (!/^launch-checklist-[a-f0-9]{12}\.md$/.test(saved) || sha256 !== documentHash)
      return { content: 'The sample file could not be written.' };
    return call(id.replace('preview-write-', 'preview-deliver-'), 'workspace_deliver', {
      path: saved,
      expectedSha256: sha256,
    });
  }
  if (!tools.some((tool) => tool.function?.name === 'workspace_write'))
    return { content: 'Open a local Bot’s chat to try the sample checklist.' };
  const suffix = randomBytes(6).toString('hex');
  return call('preview-write-' + suffix, 'workspace_write', {
    path: 'launch-checklist-' + suffix + '.md',
    content: document,
  });
}

const model = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== 'Bearer ' + modelKey) {
    response.writeHead(401).end();
    return;
  }
  try {
    let length = 0;
    const chunks = [];
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) throw Error('Request too large');
      chunks.push(chunk);
    }
    const delta = sampleReply(JSON.parse(Buffer.concat(chunks)));
    const frame = (value, finish_reason) =>
      'data: ' +
      JSON.stringify({
        id: 'developer-preview',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta: value, finish_reason }],
      }) +
      '\n\n';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      frame({ role: 'assistant', ...delta }, null) +
        frame({}, delta.tool_calls ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
    );
  } catch {
    response.writeHead(400).end();
  }
});

const directory = await mkdtemp(join(tmpdir(), 'bambooshift-preview-'));
const runtime = join(directory, 'runtime');
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let child;
let closed;
let cookie;
let userId;

try {
  await cargo('build', ['--bin', 'openbot-backend']);
  if (shutdown.signal.aborted) throw shutdown.signal.reason;
  await buildWorkers(runtime);
  await symlink(join(root, 'node_modules'), join(runtime, 'node_modules'), 'junction');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    envDir: false,
    build: { outDir: join(runtime, 'dist'), emptyOutDir: false },
    logLevel: 'warn',
  });
  if (shutdown.signal.aborted) throw shutdown.signal.reason;
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const config = join(directory, 'server.private.json');
  await writeFile(
    config,
    JSON.stringify({
      dataDir: join(directory, 'workspace-data'),
      bind: '127.0.0.1:0',
      runtimeDir: runtime,
      nodeBinary: process.execPath,
    }),
    { mode: 0o600 },
  );
  child = launchBackend(['--config', config], {
    env: { ...process.env, OPENBOT_BACKEND_BINARY: rustBinary() },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  closed = once(child, 'close');
  void closed.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const origin = await Promise.race([
    closed.then(() => {
      throw Error('The preview backend closed during startup.');
    }),
    (async () => {
      for await (const line of lines) {
        const ready = JSON.parse(line);
        if (ready.type !== 'openbot:ready') continue;
        if (ready.backend !== 'rust' || !/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(ready.address))
          throw Error('Expected a Rust preview on a loopback address.');
        return 'http://' + ready.address;
      }
      throw Error('The preview backend did not report a listener.');
    })(),
    delay(30_000, undefined, { ref: false, signal: shutdown.signal }).then(() => {
      throw Error('The preview backend did not start within 30 seconds.');
    }),
  ]).finally(() => lines.close());

  async function api(path, status, method = 'GET', body) {
    const response = await fetch(origin + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]),
      headers: {
        ...(cookie ? { Cookie: cookie, 'X-OpenBot-Expected-User': userId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body && JSON.stringify(body),
    });
    if (response.status !== status)
      throw Error(method + ' ' + path + ' returned ' + response.status);
    return response;
  }

  const email = 'developer-preview@example.test';
  const password = randomBytes(18).toString('base64url');
  const registration = await api('/api/account/register', 201, 'POST', {
    email,
    password,
    name: 'Demo Developer',
    kind: 'personal',
  });
  const account = await registration.json();
  userId = account.user.id;
  cookie = registration.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const path = '/api/workspaces/' + account.workspaceId;
  await api(path + '/settings', 200, 'PUT', {
    provider: 'developer-preview',
    model: 'fixture',
    baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1',
    apiKey: modelKey,
  });

  if (check) {
    const health = await (await api('/api/health', 200)).json();
    const homepage = await (await api('/', 200)).text();
    if (health.backend !== 'rust' || health.runtime !== 'pi' || !homepage.includes('id="root"'))
      throw Error('The preview did not serve the product UI and Pi backend.');
    const bootstrap = async () => (await api(path + '/bootstrap', 200)).json();
    const { conversations, agents } = await bootstrap();
    const agent = agents[0];
    const chat = conversations.find((entry) => !entry.isGroup && entry.agentIds.includes(agent.id));
    await api(path + '/conversations/' + chat.id + '/messages', 202, 'POST', {
      content: prompt,
      agentId: agent.id,
      clientId: randomUUID(),
      mode: 'followUp',
    });
    const deadline = Date.now() + 35_000;
    for (;;) {
      const { messages } = await bootstrap();
      if (messages.some((message) => message.status === 'done' && message.content === done)) {
        const attachment = messages.find((message) => message.kind === 'file');
        const fileId = attachment?.metadata?.fileId;
        if (!fileId || attachment.metadata.sha256 !== documentHash)
          throw Error('The preview did not publish the expected file card.');
        const download = await api(
          path + '/files/' + encodeURIComponent(fileId) + '/download',
          200,
        );
        if ((await download.text()) !== document) throw Error('The preview file contents changed.');
        console.log('Developer preview passed: product UI, account, Pi tools, file delivery.');
        break;
      }
      if (Date.now() >= deadline || messages.some((message) => message.status === 'error'))
        throw Error('The developer preview did not complete the sample task.');
      await delay(250, undefined, { signal: shutdown.signal });
    }
  } else {
    console.log('\nOpen the developer preview in a private browser window.');
    console.log(origin + '/login');
    console.log('Temporary account: ' + email);
    console.log('Temporary password: ' + password);
    console.log('Open a Bot chat and send: ' + prompt);
    console.log('Press Ctrl+C to stop the preview and remove its workspace.');
    if (!shutdown.signal.aborted)
      await Promise.race([
        once(shutdown.signal, 'abort'),
        closed.then(() => {
          throw Error('The preview backend stopped.');
        }),
      ]);
  }
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
  model.closeAllConnections();
  model.close();
  await rm(directory, { recursive: true, force: true });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}

import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { StartRun } from './protocol.js';

export function stream(
  response: ServerResponse,
  content?: string,
  tool?: { name: string; arguments: unknown },
) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'synthetic-worker-model',
        object: 'chat.completion.chunk',
        model: 'fixture',
        created: 1,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  if (tool)
    chunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: randomUUID(),
          type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
        },
      ],
    });
  else chunk({ role: 'assistant', content });
  chunk({}, tool ? 'tool_calls' : 'stop');
  response.end('data: [DONE]\n\n');
}
export async function fixture(
  respond: (body: any, response: ServerResponse, count: number) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-pi-worker-'));
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const part of request) text += part;
    const body = JSON.parse(text);
    requests.push(body);
    respond(body, response, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('server/workers/pi-worker/index.ts')],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'HOST_KEY_MUST_NOT_BE_USED',
        OPENAI_ORG_ID: 'HOST_ORGANIZATION_MUST_NOT_BE_USED',
      },
    },
  );
  const events: any[] = [];
  let pending = '',
    stderr = '',
    exitCode: number | null = null;
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  child.stdout.on('data', (bytes) => {
    pending += bytes;
    let index: number;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line) events.push(JSON.parse(line));
    }
  });
  child.on('exit', (code) => {
    exitCode = code ?? -1;
  });
  const input: StartRun = {
    type: 'start',
    version: 1,
    runId: randomUUID(),
    cwd: directory,
    prompt: 'Complete this isolated synthetic task.',
    systemPrompt: 'Use only the explicitly provided tools.',
    profile: {
      provider: 'synthetic-worker',
      model: 'fixture',
      apiKey: 'SYNTHETIC_WORKSPACE_KEY',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    },
    tools: [],
  };
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  async function until(check: () => boolean, label: string) {
    const end = Date.now() + 15000;
    while (!check() && Date.now() < end) {
      if (exitCode !== null) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.ok(check(), `${label}; stderr: ${stderr}; events: ${JSON.stringify(events)}`);
  }
  return {
    input,
    events,
    requests,
    child,
    send,
    until,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise((done) => setTimeout(done, 1000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

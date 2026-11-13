import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

export const fixtures = ['first', 'restart'].map((stage) => ({
  stage,
  prompt: `BAMBOOSHIFT_PERSONAL_PACKAGE_${stage}`,
  path: `${stage}-acceptance.md`,
  content: `# Personal workspace acceptance\n\n${stage}: English and 中文.\n\nSynthetic data only.\n`,
  answer: `Synthetic ${stage} file delivered.`,
}));

function call(name, args) {
  return {
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id: `synthetic-${randomUUID()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/** A deterministic model exercises actual tools; it never fabricates a tool receipt. */
export function modelReply(body, events) {
  if (!Array.isArray(body.messages) || !Array.isArray(body.tools))
    throw Error('Invalid synthetic request.');
  const lastUser = body.messages.filter((message) => message.role === 'user').at(-1);
  let text =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : lastUser?.content
          ?.filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
  // Rust includes history in the same user envelope. Select its current content only.
  try {
    text = JSON.parse(text).content;
  } catch {
    /* Plain fixture prompts remain supported. */
  }
  const fixture = fixtures.find((item) => text === item.prompt);
  const names = body.tools.map((tool) => tool.function?.name);
  if (!fixture || !['workspace_write', 'workspace_deliver'].every((name) => names.includes(name)))
    throw Error('The request did not contain the exact synthetic fixture and real file tools.');
  const previous = events.filter((event) => event.stage === fixture.stage);
  const last = body.messages.at(-1);
  let receipt, lastName;
  if (last?.role === 'tool') {
    receipt = JSON.parse(last.content);
    lastName =
      last.name ??
      body.messages
        .filter((message) => message.tool_calls?.length)
        .at(-1)
        ?.tool_calls.at(-1).function?.name;
  }
  if (!previous.length && last?.role !== 'tool') {
    events.push({ stage: fixture.stage, step: 'write' });
    return call('workspace_write', { path: fixture.path, content: fixture.content });
  }
  if (
    previous.length === 1 &&
    lastName === 'workspace_write' &&
    /^[a-f0-9]{64}$/.test(receipt?.sha256)
  ) {
    events.push({ stage: fixture.stage, step: 'deliver' });
    return call('workspace_deliver', { path: fixture.path, expectedSha256: receipt.sha256 });
  }
  if (previous.length === 2 && lastName === 'workspace_deliver' && receipt?.delivered === true) {
    events.push({ stage: fixture.stage, step: 'done' });
    return { role: 'assistant', content: fixture.answer };
  }
  throw Error('The real tool did not confirm the expected synthetic file operation.');
}

export async function startPersonalModel() {
  const events = [],
    failures = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions')
        throw Error('Unexpected model route.');
      const chunks = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        if (bytes > 1024 * 1024) throw Error('Synthetic request is too large.');
        chunks.push(part);
      }
      const body = JSON.parse(Buffer.concat(chunks));
      if (body.stream !== true) throw Error('Expected streaming model transport.');
      const delta = modelReply(body, events);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [item, reason] of [
        [delta, null],
        [{}, delta.tool_calls ? 'tool_calls' : 'stop'],
      ])
        response.write(
          `data: ${JSON.stringify({
            id: 'synthetic-package',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: item, finish_reason: reason }],
          })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    } catch {
      failures.push('Unexpected synthetic model request or unconfirmed tool result.');
      response
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end('{"error":"synthetic-fixture-failed"}');
    }
  });
  server.requestTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    events,
    failures,
    settings: {
      provider: 'synthetic-package',
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'SYNTHETIC_PACKAGE_KEY',
    },
    close: () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  };
}

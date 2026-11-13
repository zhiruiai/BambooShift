import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MCP_IMPORT_LENGTH,
  parseRemoteMcpImport,
  readRemoteMcpPreview,
} from './remoteMcpImport';

test('MCP and VS Code imports project names and raw credential-free HTTPS strings for preview', () => {
  const result = parseRemoteMcpImport(
    JSON.stringify({
      mcpServers: {
        ' Docs ': {
          url: 'https://DOCS.example.com:443/mcp',
          headers: { Authorization: 'SECRET_HEADER' },
          env: { KEY: 'SECRET_ENV' },
          token: 'SECRET_TOKEN',
        },
        local: { command: 'npx', args: ['SECRET_COMMAND'], url: 'https://local.example.com/mcp' },
        old: { type: 'sse', url: 'https://old.example.com/sse' },
      },
      servers: {
        second: {
          type: 'http',
          url: 'https://other.example.com/mcp',
          headers: { key: 'SECRET_SECOND' },
        },
        duplicate: { type: 'streamable-http', url: 'https://docs.example.com/mcp' },
      },
      inputs: [{ id: 'apiKey', type: 'promptString' }],
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    candidates: [
      { name: 'Docs', url: 'https://DOCS.example.com:443/mcp' },
      { name: 'second', url: 'https://other.example.com/mcp' },
      { name: 'duplicate', url: 'https://docs.example.com/mcp' },
    ],
    skipped: 2,
  });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|Authorization|headers|token|command|env/);
});

test('unsafe, credential, placeholder, unsupported and malformed entries never become candidates', () => {
  const urls = [
    'http://example.com/mcp',
    'https://user:SECRET@example.com/mcp',
    'https://example.com/mcp?token=SECRET',
    'https://example.com/mcp?',
    'https://example.com/mcp#SECRET',
    'https://example.com/${TOKEN}',
    'https://example.com/<token>',
    'https://example.com/a\nb',
    'https://example.com/' + '汉'.repeat(700),
  ];
  for (const url of urls)
    assert.deepEqual(
      parseRemoteMcpImport(JSON.stringify({ servers: { fixture: { url } } })),
      { ok: false, reason: 'empty' },
      url,
    );
  for (const entry of [
    null,
    [],
    { url: 'https://example.com/mcp', type: { toString: null } },
    { url: 'https://example.com/mcp', transport: 'stdio' },
    { url: 'https://example.com/mcp', args: [] },
  ]) {
    assert.deepEqual(parseRemoteMcpImport(JSON.stringify({ servers: { fixture: entry } })), {
      ok: false,
      reason: 'empty',
    });
  }
});

test('imports bound input, entry count and existing name and URL limits without truncating endpoints', () => {
  assert.deepEqual(parseRemoteMcpImport('bad JSON SECRET'), { ok: false, reason: 'json' });
  for (const value of [[], null, {}, { servers: [] }, { url: 'https://example.com/mcp' }])
    assert.deepEqual(parseRemoteMcpImport(JSON.stringify(value)), { ok: false, reason: 'shape' });
  assert.deepEqual(parseRemoteMcpImport(' '.repeat(MAX_MCP_IMPORT_LENGTH + 1)), {
    ok: false,
    reason: 'size',
  });
  const servers = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [
      'server' + index,
      { url: `https://example.com/${index}` },
    ]),
  );
  assert.deepEqual(parseRemoteMcpImport(JSON.stringify({ servers })), {
    ok: false,
    reason: 'count',
  });
  for (const name of ['x'.repeat(81), ' ', 'hidden\u202Elabel'])
    assert.deepEqual(
      parseRemoteMcpImport(
        JSON.stringify({ servers: { [name]: { url: 'https://example.com/mcp' } } }),
      ),
      { ok: false, reason: 'empty' },
    );
});

test('members and exact endpoint proposal reviews have no configuration import entry', async () => {
  const { compile, render, props } = await import('./testSupport/appsFixture');
  const { AddAppConnectionView } = await compile(
    'web/src/components/apps/AddAppConnectionView.tsx',
  );
  const model = {
    props: props(),
    draft: { name: '', url: '', token: '', authType: 'none', shared: false },
    feedback: null,
  };
  assert.doesNotMatch(
    render(AddAppConnectionView, { ...model, props: { ...props(), canManage: false } }),
    /导入 MCP 配置/,
  );
  assert.doesNotMatch(
    render(AddAppConnectionView, { ...model, customReview: { url: 'https://example.com/mcp' } }),
    /导入 MCP 配置/,
  );
  assert.match(render(AddAppConnectionView, model), /导入 MCP 配置/);
});

test('preview response validates counts, consistency and safe fields without echoing extras', () => {
  const candidate = { name: 'Docs', url: 'https://example.com/mcp' };
  const result = { candidates: [candidate], skipped: 0, error: null };
  assert.deepEqual(
    readRemoteMcpPreview({
      ...result,
      token: 'SYNTHETIC_SECRET',
      candidates: [{ ...candidate, headers: { Authorization: 'SYNTHETIC_SECRET' } }],
    }),
    result,
  );
  assert.deepEqual(readRemoteMcpPreview({ candidates: [], skipped: 100, error: 'empty' }), {
    candidates: [],
    skipped: 100,
    error: 'empty',
  });
  for (const value of [
    null,
    [],
    {},
    { candidates: [], skipped: 0, error: null },
    { ...result, error: 'empty' },
    { ...result, skipped: -1 },
    { ...result, skipped: 100 },
    { ...result, skipped: 0.5 },
    { ...result, candidates: [candidate, candidate] },
    { ...result, candidates: [{ ...candidate, name: ' Docs ' }] },
    { ...result, candidates: [{ ...candidate, url: 'https://user:SYNTHETIC@example.com/mcp' }] },
    { ...result, candidates: [{ ...candidate, url: 'https://example.com/?token=SYNTHETIC' }] },
    { ...result, candidates: [{ ...candidate, url: 'https://example.com/' + 'a'.repeat(2048) }] },
  ])
    assert.throws(() => readRemoteMcpPreview(value), /^Error: Invalid import preview response\.$/);
});

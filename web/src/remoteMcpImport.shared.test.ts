import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseRemoteMcpImport } from './remoteMcpImport';

const fixture = JSON.parse(
  readFileSync(new URL('../../shared/fixtures/remote-mcp-import.json', import.meta.url), 'utf8'),
);

for (const item of fixture.cases) {
  test(`shared MCP import: ${item.name}`, () => {
    assert.deepEqual(
      parseRemoteMcpImport(item.source ?? JSON.stringify(item.input)),
      item.projectionExpected,
    );
  });
}

for (const item of fixture.addresses) {
  test(`shared MCP address: ${item.name}`, () => {
    assert.deepEqual(
      parseRemoteMcpImport(JSON.stringify({ servers: { fixture: { url: item.input } } })),
      !item.projected
        ? { ok: false, reason: 'empty' }
        : { ok: true, candidates: [{ name: 'fixture', url: item.input }], skipped: 0 },
    );
  });
}

test('shared MCP limits use UTF16 input/name length and UTF8 address length', () => {
  const { sourceUtf16, servers, nameUtf16, urlUtf8 } = fixture.limits;
  const source = JSON.stringify({ servers: { fixture: { url: 'https://example.com/mcp' } } });
  assert.equal(parseRemoteMcpImport(source.padEnd(sourceUtf16)).ok, true);
  assert.deepEqual(parseRemoteMcpImport(source.padEnd(sourceUtf16 + 1)), {
    ok: false,
    reason: 'size',
  });
  const entries = Object.fromEntries(
    Array.from({ length: servers }, (_, i) => [String(i), { url: `https://example.com/${i}` }]),
  );
  assert.equal(parseRemoteMcpImport(JSON.stringify({ servers: entries })).ok, true);
  entries.extra = { url: 'https://example.com/extra' };
  assert.deepEqual(parseRemoteMcpImport(JSON.stringify({ servers: entries })), {
    ok: false,
    reason: 'count',
  });
  for (const name of ['x'.repeat(nameUtf16), '🐼'.repeat(nameUtf16 / 2)]) {
    assert.equal(
      parseRemoteMcpImport(JSON.stringify({ servers: { [name]: { url: 'https://example.com/' } } }))
        .ok,
      true,
    );
    assert.deepEqual(
      parseRemoteMcpImport(
        JSON.stringify({ servers: { [name + 'x']: { url: 'https://example.com/' } } }),
      ),
      { ok: false, reason: 'empty' },
    );
  }
  const url = 'https://example.com/'.padEnd(urlUtf8, 'a');
  assert.equal(parseRemoteMcpImport(JSON.stringify({ servers: { fixture: { url } } })).ok, true);
  for (const value of [url + 'a', 'https://example.com/' + '汉'.repeat(700)]) {
    assert.deepEqual(
      parseRemoteMcpImport(JSON.stringify({ servers: { fixture: { url: value } } })),
      { ok: false, reason: 'empty' },
    );
  }
});

test('shared invalid names and transports never become candidates', () => {
  for (const name of fixture.invalidNames) {
    assert.deepEqual(
      parseRemoteMcpImport(
        JSON.stringify({ servers: { [name]: { url: 'https://example.com/' } } }),
      ),
      { ok: false, reason: 'empty' },
    );
  }
  for (const type of fixture.invalidTransports) {
    for (const field of ['type', 'transport']) {
      assert.deepEqual(
        parseRemoteMcpImport(
          JSON.stringify({ servers: { fixture: { url: 'https://example.com/', [field]: type } } }),
        ),
        { ok: false, reason: 'empty' },
      );
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarizeLibrsvgTree } from './librsvg-source-graph.mjs';

const record = (name) => ({
  name,
  version: '1.0.0',
  sourceSha256: 'a'.repeat(64),
  sourceUrl: `https://static.crates.io/crates/${name}/${name}-1.0.0.crate`,
});
const catalog = { packages: [record('shared'), record('target-only')] };

test('keeps only selected source candidates and strips local workspace paths', () => {
  const graph = summarizeLibrsvgTree(
    [
      '0librsvg-c v2.63.2 (/synthetic/private/source/librsvg-c)|features=',
      '1librsvg v2.63.2 (/synthetic/private/source/rsvg)|features=capi',
      '2shared v1.0.0|features=std',
      '1shared v1.0.0|features=std (*)',
    ].join('\n'),
    catalog,
  );
  assert.equal(graph.registryPackages, 1);
  assert.equal(JSON.stringify(graph).includes('private'), false);
  assert.equal(JSON.stringify(graph).includes('target-only'), false);
  assert.deepEqual(graph.edges, [
    ['librsvg-c@2.63.2', 'librsvg@2.63.2'],
    ['librsvg-c@2.63.2', 'shared@1.0.0'],
    ['librsvg@2.63.2', 'shared@1.0.0'],
  ]);
});

test('rejects an all-workspace tree, incomplete tree, or unverified source', () => {
  for (const text of [
    '0rsvg_convert v2.63.2|features=',
    '0librsvg-c v2.63.2|features=\n2shared v1.0.0|features=',
    '0librsvg-c v2.63.2|features=\n0librsvg v2.63.2|features=',
    '0librsvg-c v2.63.2|features=\n1unknown v1.0.0|features=',
  ])
    assert.throws(() => summarizeLibrsvgTree(text, catalog));
});

test('rejects replacement URLs and missing source checksums', () => {
  const tree = '0librsvg-c v2.63.2|features=\n1shared v1.0.0|features=';
  for (const change of [{ sourceUrl: 'https://example.test/source' }, { sourceSha256: '' }])
    assert.throws(
      () => summarizeLibrsvgTree(tree, { packages: [{ ...record('shared'), ...change }] }),
      /checksum-bound/,
    );
});

test('recorded library graphs keep platform distinctions and exclude CLI/test roots', async () => {
  const report = JSON.parse(
    await readFile(
      new URL('../../legal/third-party/sharp-libvips-1.3.4/TARGET-GRAPHS.json', import.meta.url),
    ),
  );
  for (const [target, graph] of Object.entries(report.targets)) {
    const selected = Object.keys(graph.featuresByPackage);
    assert.equal(
      selected.filter((id) => report.registrySources[id]).length,
      graph.registryPackageCount,
    );
    assert.equal(
      selected.some((id) => /^(rsvg_convert|criterion|libfuzzer-sys)@/.test(id)),
      false,
    );
    assert.deepEqual(graph.featuresByPackage['image@0.25.10'], ['jpeg', 'png']);
    assert.equal(graph.featuresByPackage['cairo-rs@0.22.9'].includes('pdf'), false);
    assert.equal(graph.featuresByPackage['cairo-rs@0.22.9'].includes('ps'), false);
    assert.equal(graph.legacyNoticePackagesSelected.length, target.includes('apple') ? 4 : 0);
    for (const [parent, child] of graph.edges) {
      assert.ok(selected.includes(parent));
      assert.ok(selected.includes(child));
    }
  }
  assert.equal(report.verification.compilationPerformed, false);
  assert.equal(JSON.stringify(report).includes('/Users/'), false);
});

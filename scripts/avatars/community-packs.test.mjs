import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const base = new URL('../../shared/avatar-packs/', import.meta.url);
const read = async (file) => JSON.parse(await readFile(new URL(file, base), 'utf8'));

test('catalog exposes complete pinned upstream inventories without changing role keys', async () => {
  const catalog = await read('catalog.json');
  assert.deepEqual(catalog.packs.map((pack) => [pack.id, pack.themes.length]), [['open-avatar', 22], ['grokbot', 18]]);
  const ids = catalog.packs.flatMap((pack) => pack.themes.map((theme) => theme.id));
  assert.equal(new Set(ids).size, 40);
  for (const pack of catalog.packs) {
    const manifest = await read(`${pack.id}/manifest.json`);
    const sources = await read(`${pack.id}/SOURCES.json`);
    assert.equal(manifest.revision, sources.revision);
    assert.equal(manifest.license, sources.license);
    assert.deepEqual(Object.keys(manifest.shapes), pack.themes.map((theme) => theme.sourceId));
    assert(sources.files.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)));
    for (const theme of pack.themes) {
      assert.equal(theme.id, `${pack.id}-${theme.sourceId}`);
      assert(theme.label.en && theme.label.zh);
    }
  }
});

test('all native eye rings are finite closed-topology inputs and all states resolve', async () => {
  for (const family of ['open-avatar', 'grokbot']) {
    const manifest = await read(`${family}/manifest.json`);
    const expressions = await read(`${family}/expressions.json`);
    assert.equal(Object.keys(expressions).length, family === 'grokbot' ? 25 : 66);
    assert.equal(Object.keys(manifest.states).length, family === 'grokbot' ? 39 : 3);
    for (const rings of Object.values(expressions)) {
      assert.equal(rings.length, 2);
      for (const ring of rings) {
        assert.equal(ring.length, 48);
        assert.equal(new Set(ring.map((point) => point.join(','))).size, 48);
        assert(ring.every((p) => p.length === 2 && p.every((n) => Number.isFinite(n) && n > -10 && n < 110)));
      }
    }
    for (const shape of Object.values(manifest.shapes)) {
      assert.match(shape.body.path, /^[Mm]/);
      assert(!/[<>]|https?:|javascript:/i.test(shape.body.path));
      assert.equal(shape.eyeTransform.length, 6);
      assert(shape.eyeTransform.every(Number.isFinite));
      assert(shape.eyeScale > 0);
      for (const id of Object.values(shape.expressions ?? {})) assert(expressions[id]);
    }
    for (const state of Object.values(manifest.states)) {
      for (const id of state.expressions ?? []) assert(expressions[id]);
    }
  }
});

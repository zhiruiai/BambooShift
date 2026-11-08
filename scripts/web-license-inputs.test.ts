import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readWebLicenseInputs } from './web-license-inputs.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'openbot-web-notice-test-'));
  try {
    await mkdir(join(root, '.build/web-notice-inputs'), { recursive: true });
    await writeFile(join(root, 'package-lock.json'), 'synthetic lockfile');
    for (const surface of ['product', 'operations']) {
      const directory = surface === 'product' ? 'dist' : 'operations-dist';
      await mkdir(join(root, directory));
      await writeFile(join(root, directory, 'index.html'), '<main>Synthetic</main>');
      await writeFile(join(root, '.build/web-notice-inputs', surface + '.json'),
        JSON.stringify({
          version: 1, surface, lockSha256: sha256('synthetic lockfile'),
          files: [{ path: 'index.html', sha256: sha256('<main>Synthetic</main>') }],
          packages: [{ name: 'synthetic', version: '1.0.0', packagePath: 'node_modules/synthetic' }],
        }));
    }
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('both surfaces contribute verified dependencies without duplicate packages', async () => {
  await fixture(async root => {
    assert.deepEqual(await readWebLicenseInputs(root), [
      { name: 'synthetic', version: '1.0.0', packagePath: 'node_modules/synthetic' },
    ]);
  });
});

test('dependency collection rejects a changed lockfile or bundle', async () => {
  for (const file of ['package-lock.json', 'dist/index.html', 'operations-dist/index.html']) {
    await fixture(async root => {
      await writeFile(join(root, file), 'changed after collection');
      await assert.rejects(readWebLicenseInputs(root), /stale|changed/);
    });
  }
});

test('metadata cannot traverse to other artifacts or dependency directories', async () => {
  for (const field of ['file', 'package']) {
    await fixture(async root => {
      const path = join(root, '.build/web-notice-inputs/product.json');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (field === 'file') value.files[0].path = '../package-lock.json';
      else value.packages[0].packagePath = 'node_modules/../private';
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(readWebLicenseInputs(root), /Invalid web/);
    });
  }
});

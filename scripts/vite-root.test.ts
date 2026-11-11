import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';
import { frontendConfig } from './vite.shared.js';

test('a checkout below release/data can serve both frontends while its private/generated directories stay denied', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'bambooshift-vite-root-'));
  const root = join(temporary, 'release', 'data', 'source [qa]');
  try {
    for (const directory of [
      'web',
      'operations',
      'shared',
      'data',
      'release',
      'config/private',
      '.tools',
      '.local',
      '.build',
      '.git',
    ])
      await mkdir(join(root, directory), { recursive: true });
    for (const surface of ['web', 'operations'])
      await writeFile(
        join(root, surface, 'index.html'),
        '<html><body>Fixture application</body></html>',
      );
    await writeFile(join(root, 'shared', 'fixture.ts'), 'export const fixture = true;');
    const privatePaths = [
      'data/value.json',
      'release/archive.txt',
      'config/private/settings.json',
      '.tools/value.txt',
      '.local/value.txt',
      '.build/value.txt',
      '.git/config',
      '.env',
      '.env.local',
      'key.pem',
    ];
    const protectedFiles = ['', 'web/nested', 'operations/nested'].flatMap((prefix) =>
      privatePaths.map((file) => join(prefix, file)),
    );
    for (const file of protectedFiles) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), 'SYNTHETIC_PRIVATE_FIXTURE');
    }
    for (const mode of ['product', 'operations'] as const) {
      const config = frontendConfig(mode, {}, root);
      const server = await createServer({
        ...config,
        configFile: false,
        logLevel: 'silent',
        server: { ...config.server, port: 0 },
      });
      try {
        await server.listen();
        const address = server.httpServer!.address();
        assert.ok(address && typeof address === 'object');
        const base = `http://127.0.0.1:${address.port}`;
        const index = await fetch(base);
        assert.equal(index.status, 200, mode);
        assert.match(await index.text(), /Fixture application/);
        const shared = await fetch(`${base}/@fs/${join(root, 'shared/fixture.ts')}`);
        assert.equal(shared.status, 200, `${mode}: shared source`);
        for (const file of protectedFiles) {
          const response = await fetch(`${base}/@fs/${join(root, file)}`);
          assert.equal(response.status, 403, `${mode}: ${file}`);
          assert.ok(!(await response.text()).includes('SYNTHETIC_PRIVATE_FIXTURE'));
        }
      } finally {
        await server.close();
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

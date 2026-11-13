import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { desktopDependencyLock } from './runtime-dependencies.mjs';
import { productionLock } from '../worker-runtime-lock.mjs';

const source = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url)));
const project = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const base = productionLock(source, ['pdfjs-dist', 'sharp']);
base.manifest.overrides = project.overrides;

test('desktop keeps exact native Sharp support while leaving PDF rasterization optional', () => {
  for (const [platform, arch, libc, suffix] of [
    ['darwin', 'arm64', undefined, 'darwin-arm64'],
    ['darwin', 'x64', undefined, 'darwin-x64'],
    ['linux', 'arm64', 'glibc', 'linux-arm64'],
    ['linux', 'x64', 'glibc', 'linux-x64'],
    ['linux', 'arm64', 'musl', 'linuxmusl-arm64'],
    ['linux', 'x64', 'musl', 'linuxmusl-x64'],
  ]) {
    const result = desktopDependencyLock(base.manifest, base.lock, { platform, arch, libc });
    for (const name of [`@img/sharp-${suffix}`, `@img/sharp-libvips-${suffix}`]) {
      const original = source.packages[`node_modules/${name}`];
      assert.equal(result.manifest.dependencies[name], original.version);
      assert.equal(result.lock.packages[`node_modules/${name}`].integrity, original.integrity);
      assert.equal(result.lock.packages[`node_modules/${name}`].optional, undefined);
    }
    assert.deepEqual(result.manifest.overrides, project.overrides);
    assert.equal(result.lock.packages['node_modules/@napi-rs/canvas'].optional, true);
    assert.equal(result.manifest.dependencies['@napi-rs/canvas'], undefined);
    assert.deepEqual(result.lock.packages[''].dependencies, result.manifest.dependencies);
  }
  assert.throws(
    () => desktopDependencyLock(base.manifest, base.lock, { platform: 'linux', arch: 'x64' }),
    /C library/,
  );
  assert.throws(
    () => desktopDependencyLock(base.manifest, base.lock, { platform: 'win32', arch: 'x64' }),
    /supported/,
  );
});

test('a new optional capability needs review before it can be omitted from desktop', () => {
  const changed = structuredClone(base.lock);
  changed.packages['node_modules/pdfjs-dist'].optionalDependencies['new-codec'] = '1.0.0';
  changed.packages['node_modules/new-codec'] = {
    version: '1.0.0',
    integrity: 'sha512-synthetic',
    optional: true,
  };
  assert.throws(
    () =>
      desktopDependencyLock(base.manifest, changed, {
        platform: 'darwin',
        arch: 'arm64',
      }),
    /Review the optional runtime capability/,
  );
});

test('projection promotes required transitive paths regardless of their root-lock flags', () => {
  const entry = { version: '1.0.0', integrity: 'sha512-synthetic', optional: true };
  const result = productionLock(
    {
      lockfileVersion: 3,
      packages: {
        '': { version: '1.0.0' },
        'node_modules/required': { ...entry, dependencies: { child: '1.0.0' } },
        'node_modules/child': { ...entry, dependencies: { leaf: '1.0.0' } },
        'node_modules/leaf': entry,
        'node_modules/optional-parent': { ...entry, optionalDependencies: { child: '1.0.0' } },
      },
    },
    ['required', 'optional-parent'],
  );
  for (const name of ['required', 'child', 'leaf'])
    assert.equal(result.lock.packages[`node_modules/${name}`].optional, undefined);
});

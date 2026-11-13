import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkClientRelease } from './check-client-release.mjs';
import { writeClientArchive } from './fixtures/client-archive.mjs';

const target = { platform: 'darwin', arch: 'arm64' };
const base = 'Synthetic.app/Contents/Resources/';
const root = base + 'bambooshift-runtime/';
const runtime = {
  version: 1,
  platform: 'darwin',
  architecture: 'arm64',
  server: 'openbot-backend',
  node: 'bin/node',
  runtime: 'runtime',
  releaseApproval: true,
};
const bundled = (value = runtime) => ({
  [base + 'app.asar']: 'Synthetic app',
  [root + 'desktop-runtime.json']: JSON.stringify(value),
  [root + 'openbot-backend']: 'Synthetic backend',
  [root + 'bin/node']: 'Synthetic node',
  [root + 'runtime/package.json']: '{}',
});

async function fixture(t, selectedTarget = target) {
  const directory = await mkdtemp(join(tmpdir(), 'client-release-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'client.zip');
  return async (entries) => {
    await writeClientArchive(archive, entries);
    return () => checkClientRelease(archive, selectedTarget);
  };
}

test('legacy connection ZIPs remain valid without new metadata', async (t) => {
  const make = await fixture(t);
  assert.deepEqual(await (await make({ [base + 'app.asar']: 'Synthetic app' }))(), {
    bundledRuntime: false,
  });
  const check = await make({
    [base + 'app.asar']: 'Synthetic app',
    'Synthetic/manifest-darwin-arm64.json': JSON.stringify({
      ...target,
      serviceIncluded: false,
      signedForDistribution: false,
    }),
  });
  assert.deepEqual(await check(), { bundledRuntime: false });
});

test('the current Windows connection-client manifest remains publishable', async (t) => {
  const windows = { platform: 'win32', arch: 'x64' };
  const make = await fixture(t, windows);
  const check = await make({
    'Synthetic/Synthetic.exe': 'Synthetic executable',
    'Synthetic/resources/app.asar': 'Synthetic app',
    'Synthetic/manifest-win32-x64.json': JSON.stringify({
      ...windows,
      serviceIncluded: false,
      signedForDistribution: false,
    }),
  });
  assert.deepEqual(await check(), { bundledRuntime: false });
  await assert.rejects(
    await make(
      bundled({
        ...runtime,
        platform: 'win32',
        architecture: 'x64',
      }),
    ),
    /no bundled runtime release schema/,
  );
});

test('a bundled runtime needs explicit boolean approval and valid target identity', async (t) => {
  const make = await fixture(t);
  assert.deepEqual(await (await make(bundled()))(), { bundledRuntime: true });
  for (const releaseApproval of [undefined, false, null, 'true', 1]) {
    await assert.rejects(await make(bundled({ ...runtime, releaseApproval })), /release blocked/i);
  }
  for (const patch of [{ version: 2 }, { platform: 'win32' }, { architecture: 'x64' }])
    await assert.rejects(await make(bundled({ ...runtime, ...patch })), /identity is invalid/);
});

test('native candidate markers remain blocked even if an outer approval is true', async (t) => {
  const make = await fixture(t);
  for (const patch of [
    { nativeImage: { releaseApproval: false } },
    { nativeImage: { releaseApproval: true } },
    { nativeImageCandidate: true },
    { nested: { releaseApproval: false } },
    { nested: [{ nativeImageCandidate: true }] },
  ])
    await assert.rejects(await make(bundled({ ...runtime, ...patch })), /not approved/);
  await assert.rejects(
    await make({
      ...bundled(),
      [root + 'runtime/native-image-runtime/overlay.json']: '{"releaseApproval":true}',
    }),
    /not approved/,
  );
});

test('missing, malformed, oversized or conflicting runtime metadata fails closed', async (t) => {
  const make = await fixture(t);
  for (const value of ['not JSON', 'null', '[]', JSON.stringify('x'.repeat(270_000))])
    await assert.rejects(
      await make({
        ...bundled(),
        [root + 'desktop-runtime.json']: value,
      }),
      /metadata/,
    );
  const missing = bundled();
  delete missing[root + 'desktop-runtime.json'];
  await assert.rejects(await make(missing), /requires one release manifest/);
  const incomplete = bundled();
  delete incomplete[root + 'bin/node'];
  await assert.rejects(await make(incomplete), /incomplete/);
  await assert.rejects(
    await make({
      ...bundled(),
      'Other/bambooshift-runtime/unlisted': 'Synthetic',
    }),
    /ambiguous bundled runtime roots/,
  );
  await assert.rejects(
    await make({
      ...bundled(),
      'Synthetic/manifest-darwin-arm64.json': JSON.stringify({
        ...target,
        serviceIncluded: false,
        releaseApproval: true,
      }),
    }),
    /hides a bundled runtime/,
  );
});

test('a client sidecar cannot release candidates or declare an absent runtime', async (t) => {
  const make = await fixture(t);
  for (const patch of [
    { releaseApproval: false },
    { nativeImageCandidate: true },
    { serviceIncluded: true },
    { platform: 'win32' },
  ])
    await assert.rejects(
      await make({
        [base + 'app.asar']: 'Synthetic',
        'Synthetic/manifest-darwin-arm64.json': JSON.stringify({
          ...target,
          serviceIncluded: false,
          ...patch,
        }),
      }),
      /release blocked/i,
    );
});

test('corrupt ZIPs cannot be mistaken for connection clients', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'client-release-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'client.zip');
  await writeFile(archive, 'not a ZIP');
  await assert.rejects(checkClientRelease(archive, target));
});

test('ZIP path aliases cannot conceal or overwrite an unapproved runtime', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'client-release-alias-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'client.zip');
  for (const name of [
    root + '/desktop-runtime.json',
    root + 'DESKTOP-RUNTIME.JSON',
    root.replace('bambooshift-runtime/', 'bambooshift-runtime./') + 'desktop-runtime.json',
  ]) {
    // Mutate only same-length local/central filenames in a real ZIP. This creates
    // aliases that the host filesystem would otherwise normalize before zipping.
    const placeholder = 'x'.repeat(name.length);
    await writeClientArchive(archive, { ...bundled(), [placeholder]: '{"releaseApproval":false}' });
    const bytes = await readFile(archive);
    let offset = 0,
      replaced = 0;
    while ((offset = bytes.indexOf(placeholder, offset)) !== -1) {
      bytes.write(name, offset, 'utf8');
      offset += name.length;
      replaced++;
    }
    assert.equal(replaced, 2);
    await writeFile(archive, bytes);
    await assert.rejects(checkClientRelease(archive, target), /invalid or ambiguous ZIP inventory/);
  }
  await writeClientArchive(archive, {
    [base + 'BAMBOOSHIFT-RUNTIME/desktop-runtime.json']: '{"releaseApproval":false}',
  });
  await assert.rejects(checkClientRelease(archive, target), /noncanonical bundled runtime/);
});

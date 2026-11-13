import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  candidateAddonPath,
  candidateRecord,
  contractResult,
  exportCandidate,
} from './qualify.mjs';
import { addonPath } from '../native-runtime-overlay-inputs.mjs';
import { nativeDistributionFixture } from '../fixtures/native-runtime.mjs';
import { hostedProfile, validateToolchain } from './toolchain.mjs';

const identity = 'a'.repeat(64);
const sample = {
  manifest: {
    releaseApproval: false,
    toolchain: validateToolchain(hostedProfile, {
      platform: 'darwin',
      arch: 'arm64',
      node: '24.22.3',
      pythonArch: 'arm64',
      python: '3.14.10',
      pkgConfig: '3.0.10',
      sdk: '26.2',
      clang: 'Apple clang version 17.0.0 (clang-1700.0.0.1)',
      clangxx: 'Apple clang version 17.0.0 (clang-1700.0.0.1)',
      xcode: 'Xcode 26.3\nBuild version 17C529',
      meson: '1.12.1',
      ninja: '1.13.2.git.kitware.jobserver-pipe-1',
      cmake: 'cmake version 4.4.4',
    }),
    binary: { sha256: identity, library: { sha256: identity } },
    source: { sha256: identity },
  },
  manifestSha256: identity,
  commit: 'b'.repeat(40),
  verification: { manifestSha256: identity },
  runtime: {
    actualLoadedLibrarySha256: identity,
    actualLoadedContained: true,
    svgInput: false,
    addonBeforeSha256: identity,
    addonAfterSha256: identity,
    originalLibrarySha256: identity,
    npmLockSha256: identity,
  },
  contract: { tests: 27, failed: 0, cancelled: 0, skipped: 0 },
};

test('candidate evidence never confers release approval or preserves private diagnostics', () => {
  const result = candidateRecord({
    ...sample,
    runtime: { ...sample.runtime, path: '/private/host' },
    verification: { ...sample.verification, stdout: 'private compiler logs' },
  });
  assert.equal(result.releaseApproval, false);
  assert.equal(result.originalNpmArtifact, false);
  assert.equal(result.status, 'clean-ci-candidate-only');
  assert.doesNotMatch(JSON.stringify(result), /private/);
  for (const runtime of [
    { svgInput: true },
    { actualLoadedContained: false },
    { actualLoadedLibrarySha256: 'f'.repeat(64) },
    { addonAfterSha256: 'c'.repeat(64) },
  ])
    assert.throws(
      () => candidateRecord({ ...sample, runtime: { ...sample.runtime, ...runtime } }),
      /identities/,
    );
  assert.throws(
    () => candidateRecord({ ...sample, manifest: { ...sample.manifest, releaseApproval: true } }),
    /identities/,
  );
  assert.throws(
    () => candidateRecord({ ...sample, verification: { manifestSha256: 'c'.repeat(64) } }),
    /identities/,
  );
});

test('contract evidence rejects partial, skipped, cancelled, failed or absent image suites', () => {
  const output = '# tests 27\n# fail 0\n# cancelled 0\n# skipped 0\n';
  assert.equal(contractResult(output).tests, 27);
  for (const value of [
    '',
    output.replace('27', '26'),
    output.replace('fail 0', 'fail 1'),
    output.replace('skipped 0', 'skipped 1'),
    output.replace('cancelled 0', 'cancelled 1'),
  ])
    assert.throws(() => contractResult(value), /complete image contract/);
});

test('isolated qualification uses the reviewed versioned native addon path', () => {
  assert.equal(`runtime/${candidateAddonPath}`, addonPath);
  assert.match(candidateAddonPath, /sharp-darwin-arm64-0\.35\.5\.node$/);
});

test('candidate export is atomic, includes source and refuses changed or pre-existing artifacts', async (t) => {
  const f = await nativeDistributionFixture(t);
  const bytes = await readFile(join(f.artifacts, 'distribution.json'));
  const output = join(f.root, 'export');
  await exportCandidate(f.artifacts, bytes, candidateRecord(sample), output);
  assert.deepEqual((await readdir(output)).sort(), [
    'CANDIDATE-CI.json',
    'SHA256SUMS',
    'binary.tar.gz',
    'distribution.json',
    'source.tar.gz',
  ]);
  await assert.rejects(exportCandidate(f.artifacts, bytes, candidateRecord(sample), output), {
    code: 'EEXIST',
  });
  assert.deepEqual(
    await readFile(join(output, 'source.tar.gz')),
    await readFile(join(f.artifacts, 'source.tar.gz')),
  );
  await writeFile(join(f.artifacts, 'source.tar.gz'), 'changed archive');
  const failedOutput = join(f.root, 'failed-export');
  await assert.rejects(
    exportCandidate(f.artifacts, bytes, candidateRecord(sample), failedOutput),
    /checksum/,
  );
  await assert.rejects(readdir(failedOutput), { code: 'ENOENT' });
  assert.equal(
    (await readdir(f.root)).some((name) => name.startsWith('.codec-artifacts-')),
    false,
  );
});

test('candidate workflow is manual, read-only, toolchain-pinned and exports no working directories', async () => {
  const source = await readFile(
    new URL('../../../.github/workflows/native-codecs-candidate.yml', import.meta.url),
    'utf8',
  );
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const job = workflow.jobs.candidate;
  assert.equal(job['runs-on'], 'macos-15');
  assert.equal(job.env.DEVELOPER_DIR, '/Applications/Xcode_26.3.app/Contents/Developer');
  const steps = job.steps;
  for (const step of steps.filter((step) => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  assert.equal(
    steps.find((step) => step.uses?.startsWith('actions/setup-node')).with['node-version'],
    '24.22.3',
  );
  assert.equal(
    steps.find((step) => step.uses?.startsWith('actions/setup-python')).with['python-version'],
    '3.14.10',
  );
  assert.equal(
    steps.find((step) => step.uses?.startsWith('actions/checkout')).with['persist-credentials'],
    false,
  );
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));
  assert.equal(upload.with.path, '${{ runner.temp }}/codec-candidate-artifacts/*');
  assert.equal(upload.if, undefined);
  assert.doesNotMatch(
    source,
    /contents: write|secrets\.|GH_TOKEN|gh release|releaseApproval: true|always\(\)/,
  );
});

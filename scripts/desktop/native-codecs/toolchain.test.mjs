import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultProfile,
  hostedProfile,
  readToolchainReport,
  toolchainProfile,
  validateToolchain,
} from './toolchain.mjs';

const local = {
  platform: 'darwin',
  arch: 'arm64',
  node: '24.22.3',
  pythonArch: 'arm64',
  python: '3.14.7',
  pkgConfig: '2.5.1',
  sdk: '26.5',
  clang: 'Apple clang version 21.0.0 (clang-2100.1.1.101)',
  clangxx: 'Apple clang version 21.0.0 (clang-2100.1.1.101)',
  meson: '1.12.1',
  ninja: '1.13.2.git.kitware.jobserver-pipe-1',
  cmake: 'cmake version 4.4.4',
};
const hosted = {
  ...local,
  python: '3.14.10',
  pkgConfig: '3.0.10',
  sdk: '26.2',
  // Synthetic compiler identity: the pinned Xcode build identifies its actual compiler.
  clang: 'Apple clang version 17.0.0 (clang-1700.0.0.1)',
  clangxx: 'Apple clang version 17.0.0 (clang-1700.0.0.1)',
  xcode: 'Xcode 26.3\nBuild version 17C529',
};

test('local and hosted profiles have independent checked provenance without host information', () => {
  assert.equal(validateToolchain(defaultProfile, local).sdk, '26.5');
  const report = validateToolchain(hostedProfile, {
    ...hosted,
    HOME: '/Users/private',
    token: 'never-copy',
    fullOutput: 'private machine',
  });
  assert.equal(report.sdk, '26.2');
  assert.equal(report.xcode, 'Xcode 26.3; Build version 17C529');
  assert.doesNotMatch(JSON.stringify(report), /private|never-copy|HOME|fullOutput/);
  assert.deepEqual(readToolchainReport(report), report);
  assert.throws(
    () => readToolchainReport({ ...report, path: '/private/build' }),
    /provenance fields/,
  );
});

test('an unavailable or changed toolchain fails closed, including native Python and Xcode', () => {
  assert.throws(() => toolchainProfile('skip'), /Unknown/);
  for (const changes of [
    { platform: 'linux' },
    { arch: 'x64' },
    { pythonArch: 'x86_64' },
    { sdk: '26.5' },
    { xcode: 'Xcode 26.4\nBuild version 17D123' },
    { node: '24.22.2' },
    { python: '3.15.2' },
    { pkgConfig: '3.0.11' },
    { cmake: 'cmake version 4.4.5' },
    { ninja: '1.13.2' },
    { meson: '1.12.10' },
    { clangxx: local.clang },
    { clang: 'clang from /Users/private' },
  ])
    assert.throws(() => validateToolchain(hostedProfile, { ...hosted, ...changes }), /Unexpected/);
  assert.throws(() => validateToolchain(defaultProfile, hosted), /Unexpected/);
});

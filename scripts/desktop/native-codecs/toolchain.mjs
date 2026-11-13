import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const defaultProfile = 'local-clt-21-sdk-26.5';
export const hostedProfile = 'github-macos-15-xcode-26.3';
const profiles = {
  [defaultProfile]: {
    sdk: '26.5',
    python: '3.14.7',
    pkgConfig: '2.5.1',
    clang: 'Apple clang version 21.0.0 (clang-2100.1.1.101)',
  },
  [hostedProfile]: {
    sdk: '26.2',
    python: '3.14.10',
    pkgConfig: '3.0.10',
    xcode: 'Xcode 26.3\nBuild version 17C529',
    developerDirectory: '/Applications/Xcode_26.3.app/Contents/Developer',
  },
};
const buildTools = {
  meson: '1.12.1',
  ninja: '1.13.2.git.kitware.jobserver-pipe-1',
  cmake: 'cmake version 4.4.4',
};

export function toolchainProfile(name = defaultProfile) {
  if (!Object.hasOwn(profiles, name)) throw Error('Unknown native toolchain profile.');
  return { ...profiles[name] };
}

// Project only checked versions; never publish command output, environment or host paths.
export function validateToolchain(name, actual) {
  const profile = toolchainProfile(name);
  for (const [key, expected] of Object.entries({
    platform: 'darwin',
    arch: 'arm64',
    node: '24.22.3',
    pythonArch: 'arm64',
    sdk: profile.sdk,
    python: profile.python,
    pkgConfig: profile.pkgConfig,
    ...buildTools,
  })) {
    if (actual[key] !== expected) throw Error(`Unexpected native toolchain: ${key}.`);
  }
  if (
    !/^Apple clang version \d+\.\d+\.\d+ \(clang-[\d.]+\)$/.test(actual.clang) ||
    actual.clang !== actual.clangxx ||
    (profile.clang && actual.clang !== profile.clang) ||
    (profile.xcode && actual.xcode !== profile.xcode)
  )
    throw Error('Unexpected Apple compiler or Xcode build.');
  return {
    profile: name,
    platform: actual.platform,
    arch: actual.arch,
    node: actual.node,
    sdk: actual.sdk,
    clang: actual.clang,
    python: actual.python,
    pkgConfig: actual.pkgConfig,
    ...buildTools,
    ...(profile.xcode ? { xcode: profile.xcode.replace('\n', '; ') } : {}),
  };
}

export function readToolchainReport(value) {
  if (!value || typeof value !== 'object') throw Error('Missing native toolchain provenance.');
  const report = validateToolchain(value.profile, {
    ...value,
    pythonArch: value.arch,
    clangxx: value.clang,
    ...(value.xcode ? { xcode: value.xcode.replace('; ', '\n') } : {}),
  });
  if (
    Object.keys(value).length !== Object.keys(report).length ||
    Object.entries(report).some(([key, item]) => value[key] !== item)
  )
    throw Error('Unexpected native toolchain provenance fields.');
  return report;
}

export function inspectToolchain({
  profile = defaultProfile,
  tools,
  env = process.env,
  execute = execFileSync,
}) {
  const expected = toolchainProfile(profile);
  const childEnv = { ...env };
  if (expected.developerDirectory) childEnv.DEVELOPER_DIR = expected.developerDirectory;
  const command = (file, args) =>
    execute(file, args, {
      encoding: 'utf8',
      env: childEnv,
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const xcrun = (...args) => command('/usr/bin/xcrun', ['--sdk', 'macosx', ...args]);
  const cc = xcrun('--find', 'clang'),
    cxx = xcrun('--find', 'clang++');
  const sdkRoot = xcrun('--show-sdk-path');
  const pkgConfig = command('/usr/bin/which', ['pkg-config']);
  if (
    expected.developerDirectory &&
    [cc, cxx, sdkRoot].some((path) => !path.startsWith(expected.developerDirectory + '/'))
  )
    throw Error('The compiler and SDK must belong to the selected Xcode installation.');
  const python = command(join(tools, 'bin/python'), [
    '-c',
    'import platform; print(platform.python_version()); print(platform.machine())',
  ]).split('\n');
  const report = validateToolchain(profile, {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    python: python[0],
    pythonArch: python[1],
    sdk: xcrun('--show-sdk-version'),
    clang: command(cc, ['--version']).split('\n')[0],
    clangxx: command(cxx, ['--version']).split('\n')[0],
    pkgConfig: command(pkgConfig, ['--version']),
    ...Object.fromEntries(
      Object.keys(buildTools).map((tool) => [
        tool,
        command(join(tools, 'bin', tool), ['--version']).split('\n')[0],
      ]),
    ),
    ...(expected.xcode ? { xcode: command('/usr/bin/xcodebuild', ['-version']) } : {}),
  });
  return {
    report,
    environment: {
      ...(expected.developerDirectory ? { DEVELOPER_DIR: expected.developerDirectory } : {}),
      BAMBOOSHIFT_NATIVE_CC: cc,
      BAMBOOSHIFT_NATIVE_CXX: cxx,
      BAMBOOSHIFT_NATIVE_PKG_CONFIG: pkgConfig,
      SDKROOT: sdkRoot,
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseClientArguments } from './options.mjs';

const host = { platform: 'darwin', arch: 'arm64' };
const root = fileURLToPath(new URL('../..', import.meta.url));
const execute = promisify(execFile);
const flag = '--native-image-candidate';

test('native image candidates are explicit and do not change ordinary client defaults', () => {
  assert.equal(parseClientArguments([], host).nativeImageArtifactsDirectory, undefined);
  assert.equal(parseClientArguments(['--with-runtime'], host).nativeImageArtifactsDirectory, undefined);
  for (const option of [[flag, './candidate assets'], [`${flag}=./candidate assets`]]) {
    const parsed = parseClientArguments(['--with-runtime', ...option], host);
    assert.equal(parsed.nativeImageArtifactsDirectory, './candidate assets');
    assert.equal(parsed.withRuntime, true);
    assert.equal(parsed.platform, 'darwin');
    assert.equal(parsed.arch, 'arm64');
  }
});

test('candidate selection rejects thin clients and every unqualified build target', () => {
  assert.throws(() => parseClientArguments([flag, './candidate'], host));
  assert.throws(() => parseClientArguments(['--dry-run', flag, './candidate'], host));
  for (const unsupported of [
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'win32', arch: 'arm64' },
    { platform: 'win32', arch: 'x64' },
  ]) {
    assert.throws(() => parseClientArguments(['--with-runtime', flag, './candidate'], unsupported));
    assert.throws(() => parseClientArguments([
      '--with-runtime', flag, './candidate', '--platform', unsupported.platform,
      '--arch', unsupported.arch,
    ], host));
  }
});

test('candidate paths cannot be omitted, ambiguous, duplicated or contain control characters', () => {
  for (const invalid of [
    [flag], [`${flag}=`], [flag, '--dry-run'], [flag, 'bad\npath'],
    [flag, 'bad\0path'], [flag, './one', `${flag}=./two`],
  ]) assert.throws(() => parseClientArguments(['--with-runtime', ...invalid], host));
});

test('candidate dry-run reports an unpublished plan without revealing its input path', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const candidate = '/synthetic-private-input/candidate-not-downloaded';
  const { stdout, stderr } = await execute(process.execPath, [
    'scripts/package-client.mjs', '--dry-run', '--with-runtime', flag, candidate,
  ], { cwd: root, timeout: 30000 });
  assert.equal(stderr, '');
  assert.ok(!stdout.includes(candidate));
  const result = JSON.parse(stdout);
  assert.equal(result.includesService, true);
  assert.equal(result.nativeImageCandidate, true);
  assert.equal(result.releaseApproval, false);
  assert.equal(result.startsClient, false);
});

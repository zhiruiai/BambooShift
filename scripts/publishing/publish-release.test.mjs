import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const publisher = fileURLToPath(new URL('./publish-release.sh', import.meta.url));
const releaseTag = 'v0.0.3';
const version = releaseTag.slice(1);
const tagRef = 'refs/tags/' + releaseTag;
const apiBoundary = 'TEST_RELEASE_API_BOUNDARY';
const apiBoundaryStatus = 27;

async function fixture(t, { brand = 'BambooShift', packageName = brand } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pandamate-release-tag-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const work = join(base, 'work');
  const remote = join(base, 'remote.git');
  const bin = join(base, 'bin');
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    PATH: bin + delimiter + process.env.PATH,
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  await mkdir(work);
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" ' + apiBoundary + ' >&2\nexit 27\n', {
    mode: 0o755,
  });
  git(base, 'init', '-q', '--bare', remote);
  git(work, 'init', '-q', '--initial-branch=main');
  git(work, 'config', 'user.name', 'Release Test');
  git(work, 'config', 'user.email', 'release@example.test');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'config', 'tag.gpgSign', 'false');
  git(work, 'remote', 'add', 'origin', remote);

  const versionFile = join(work, 'version.txt');
  await writeFile(versionFile, '0.0.1');
  await mkdir(join(work, 'scripts', 'publishing'), { recursive: true });
  await writeFile(
    join(work, 'scripts', 'publishing', 'stamp-version.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('version.txt', process.argv[2]);\n",
  );
  await mkdir(join(work, '.github', 'workflows'), { recursive: true });
  await writeFile(join(work, '.github', 'workflows', 'ci.yml'), 'name: Synthetic CI\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'Source revision');
  git(work, 'push', '-q', 'origin', 'main');
  const source = git(work, 'rev-parse', 'HEAD');

  await writeFile(versionFile, version);
  git(work, 'add', 'version.txt');
  const stamped = git(work, 'write-tree');
  git(work, 'reset', '--hard', source);

  const builds = join(base, 'pandamate-builds');
  for (const [platform, kinds] of [
    ['linux-x64', ['source.tar.gz', 'server-linux-x64.tar.gz']],
    ['macos-arm64', ['client-macos-arm64.zip']],
  ]) {
    const path = join(builds, 'pandamate-' + platform);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'source-tree.txt'), stamped + '\n');
    for (const kind of kinds) await writeFile(join(path, packageName + '-' + releaseTag + '-' + kind), kind);
  }

  return {
    source,
    stamped,
    versionFile,
    git: (...args) => git(work, ...args),
    remoteTag: () => git(remote, 'rev-parse', tagRef + '^{commit}'),
    manifest: join(builds, 'pandamate-macos-arm64', 'source-tree.txt'),
    tag(target) {
      git(work, 'tag', '-a', releaseTag, target, '-m', brand + ' release from ' + source);
      git(work, 'push', '-q', 'origin', tagRef);
    },
    async restoreDraft() {
      // All existing assets have their expected digests, so a resume should
      // keep both the archived bytes and the existing release title.
      await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const api = args.find(arg => arg.startsWith('repos/'));
const release = { id: 1, tag_name: 'untagged-fixture', draft: true,
  name: 'MosoCrew ' + process.env.RELEASE_TAG,
  body: '<!-- pandamate-source: ' + process.env.RELEASE_SOURCE + ' -->' };
if (api.endsWith('/releases?per_page=100')) {
  console.log(JSON.stringify([[release]]));
} else if (api.endsWith('/assets?per_page=100')) {
  const stage = fs.readdirSync(process.env.RUNNER_TEMP).find(name => name.startsWith('pandamate-publish.'));
  const directory = path.join(process.env.RUNNER_TEMP, stage);
  const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\\n');
  const assets = sums.map(line => {
    const [digest, name] = line.split('  ');
    return { name, digest: 'sha256:' + digest, state: 'uploaded' };
  });
  const digest = require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'))).digest('hex');
  assets.push({ name: 'SHA256SUMS.txt', digest: 'sha256:' + digest, state: 'uploaded' });
  console.log(JSON.stringify([assets]));
} else if (args.includes('PATCH')) {
  assert.ok(!args.some(arg => arg.startsWith('name=')));
  assert.ok(args.includes('draft=false'));
} else if (api.endsWith('/releases/1') && !args.includes('--method')) {
  console.log(JSON.stringify({ ...release, draft: false, tag_name: process.env.RELEASE_TAG,
    html_url: 'https://example.test/release' }));
} else {
  throw new Error('Unexpected release API call');
}
`, { mode: 0o755 });
    },
    publish() {
      return spawnSync('bash', [publisher], {
        cwd: work,
        env: {
          ...env,
          RUNNER_TEMP: base,
          RELEASE_VERSION: version,
          RELEASE_TAG: releaseTag,
          RELEASE_SOURCE: source,
          RELEASE_DAY: '2026-11-11',
          RELEASE_BRAND: brand,
          RELEASE_PACKAGE_NAME: packageName,
          GITHUB_REPOSITORY: 'example/pandamate',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
    },
  };
}

function assertReachedReleaseApi(result) {
  assert.ifError(result.error);
  assert.equal(result.status, apiBoundaryStatus, result.stderr);
  assert.match(result.stderr, new RegExp(apiBoundary));
}

test('a stamped build pushes a tag to the existing source commit and can resume it', async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.git('rev-parse', 'HEAD^{tree}'), f.stamped);
  assertReachedReleaseApi(f.publish());
  assert.equal(f.remoteTag(), f.source);
  assert.equal(f.git('for-each-ref', '--format=%(subject)', tagRef), 'BambooShift release from ' + f.source);
  assert.equal(f.git('rev-parse', 'HEAD'), f.source);
  assert.equal(f.git('write-tree'), f.stamped);
  assertReachedReleaseApi(f.publish());
  assert.equal(f.remoteTag(), f.source);
});

test('a legacy PandaMate release resumes only with the original parent and stamped tree', async (t) => {
  const f = await fixture(t, { brand: 'PandaMate' });
  await writeFile(f.versionFile, version);
  f.git('commit', '-qam', 'Legacy stamped release');
  const legacy = f.git('rev-parse', 'HEAD');
  f.tag(legacy);
  f.git('reset', '--hard', f.source);
  assertReachedReleaseApi(f.publish());
  assert.equal(f.remoteTag(), legacy);

  f.git('reset', '--hard', f.source);
  f.git('tag', '-d', releaseTag);
  f.git('push', '-q', 'origin', ':' + tagRef);
  await writeFile(f.versionFile, 'unrelated stamp');
  f.git('commit', '-qam', 'Wrong stamped tree');
  f.tag(f.git('rev-parse', 'HEAD'));
  f.git('reset', '--hard', f.source);
  const result = f.publish();
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, new RegExp(apiBoundary));
});

test('a legacy MosoCrew source resumes with its original PandaMate archive names', async (t) => {
  const f = await fixture(t, { brand: 'MosoCrew', packageName: 'PandaMate' });
  f.tag(f.source);
  await f.restoreDraft();
  const result = f.publish();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'https://example.test/release');
  assert.equal(f.remoteTag(), f.source);
  assert.equal(f.git('for-each-ref', '--format=%(subject)', tagRef), 'MosoCrew release from ' + f.source);
});

test('a mismatched build manifest stops release before pushing a tag', async (t) => {
  const f = await fixture(t);
  await writeFile(f.manifest, f.git('rev-parse', 'HEAD^{tree}') + '\n');
  const result = f.publish();
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, new RegExp(apiBoundary));
  assert.equal(f.git('tag', '--list', releaseTag), '');
});

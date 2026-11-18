import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  checkWindowsFoundation,
  foundationSuites,
  verifiedTestCount,
} from '../../acceptance/publishing/check-windows-foundation.mjs';

const summary = (passed, failed = 0, ignored = 0) =>
  `\r\ntest result: ok. ${passed} passed; ${failed} failed; ${ignored} ignored; 0 measured; 120 filtered out; finished in 0.04s\r\n`;

test('requires actual completed tests, including native private-file cases', () => {
  assert.equal(verifiedTestCount(summary(6), 6), 6);
  for (const text of [
    '',
    summary(0),
    summary(5),
    summary(6, 1),
    summary(6, 0, 1),
    summary(6) + summary(6),
    'running 6 tests\n......',
    'test result: FAILED. 6 passed; 1 failed; 0 ignored;',
  ])
    assert.throws(() => verifiedTestCount(text, 6));
});

test('unsupported hosts fail before any process or model starts', () => {
  for (const target of [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'win32', arch: 'arm64' },
  ]) {
    assert.throws(() =>
      checkWindowsFoundation({ ...target, run: () => assert.fail('must not start') }),
    );
  }
});

test('uses the locked Rust runner sequentially with explicit targets and bounded output', () => {
  const calls = [];
  const result = checkWindowsFoundation({
    platform: 'win32',
    arch: 'x64',
    print: () => {},
    run(executable, args, options) {
      const suite = foundationSuites[calls.length];
      assert.equal(executable, process.execPath);
      assert.ok(args[0].endsWith('rust-test.mjs'));
      assert.deepEqual(args.slice(1), [...suite.args, '--', '--format=terse', '--color=never']);
      assert.equal(options.shell, undefined);
      assert.equal(options.env.CARGO_TERM_COLOR, 'never');
      assert.equal(options.timeout, 25 * 60 * 1000);
      assert.equal(options.maxBuffer, 16 * 1024 * 1024);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      calls.push(args);
      return { status: 0, stdout: summary(suite.minimum), stderr: '' };
    },
  });
  assert.equal(calls.length, 6);
  assert.deepEqual(
    result.checks.map(({ passed }) => passed),
    [6, 4, 4, 1, 1, 1],
  );
  assert.match(result.scope, /Windows releases remain connection clients/);
});

test('a failed command, deadline, or missing test never continues to another suite', () => {
  for (const failure of [
    { status: 1, stdout: summary(6) },
    { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { status: 0, stdout: summary(0) },
  ]) {
    let calls = 0;
    assert.throws(() =>
      checkWindowsFoundation({
        platform: 'win32',
        arch: 'x64',
        print: () => {},
        run: () => {
          calls++;
          return failure;
        },
      }),
    );
    assert.equal(calls, 1);
  }
});

test('source and release Windows jobs share the foundation gate before packaging without extra permission', async (t) => {
  for (const [file, jobName] of [
    ['ci.yml', 'windows-client'],
    ['release.yml', 'build'],
  ]) {
    const workflow = parse(
      await readFile(new URL(`../../../.github/workflows/${file}`, import.meta.url), 'utf8'),
    );
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    const job = workflow.jobs[jobName];
    assert.equal(job.permissions, undefined);
    assert.ok(job['timeout-minutes'] >= 45);
    const foundation = job.steps.findIndex((step) =>
      step.run?.includes('node tests/acceptance/publishing/check-windows-foundation.mjs'),
    );
    const pack = job.steps.findIndex((step) =>
      step.run?.includes('node scripts/publishing/build-windows-client.mjs'),
    );
    assert.ok(foundation >= 0 && pack > foundation);
    const rust = job.steps.findIndex((step) =>
      step.run?.includes('rustup toolchain install stable --profile minimal'),
    );
    assert.ok(rust >= 0 && rust < foundation);
    if (file === 'release.yml') {
      assert.match(job.steps[foundation].if, /windows-x64/);
      assert.match(job.steps[foundation].run, /RELEASE_SOURCE.*GITHUB_SHA/);
      assert.match(job.steps[foundation].run, /exit 1/);
      const directory = await mkdtemp(join(tmpdir(), 'bambooshift-windows-release-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const current = 'a'.repeat(40);
      const pinned = 'b'.repeat(40);
      const check = (source) => spawnSync('bash', ['-c', job.steps[foundation].run], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_SHA: current, RELEASE_SOURCE: source },
      });
      assert.equal(check(current).status, 1);
      assert.equal(check(pinned).status, 0);
      for (const gate of [
        'scripts/publishing/check-windows-foundation.mjs',
        'tests/acceptance/publishing/check-windows-foundation.mjs',
      ]) {
        assert.ok(job.steps[rust].if.includes(gate));
        await mkdir(join(directory, dirname(gate)), { recursive: true });
        await writeFile(join(directory, gate), `console.log(${JSON.stringify(gate)})`);
        const result = check(pinned);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), gate);
      }
    }
    assert.ok(!JSON.stringify(job.steps.slice(rust, foundation + 1)).includes('secrets.'));
    assert.ok(!JSON.stringify(job.steps[pack]).includes('--with-runtime'));
  }
});

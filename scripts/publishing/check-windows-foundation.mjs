import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runner = fileURLToPath(new URL('../rust-test.mjs', import.meta.url));

// These are native persistence checks. They do not qualify a Windows local runtime.
export const foundationSuites = [
  { name: 'private file publication', args: ['--lib', 'filesystem::private_file'], minimum: 6 },
  { name: 'model credentials', args: ['--test', 'workspace_credentials'], minimum: 4 },
  { name: 'local profile restart', args: ['--test', 'local_desktop'], minimum: 4 },
  { name: 'connection replacement', args: ['--test', 'apps_credentials_replace'], minimum: 1 },
  {
    name: 'connection migration',
    args: [
      '--test',
      'apps_recovery',
      'legacy_secrets_move_to_private_file_without_changing_tool_schema_order',
    ],
    minimum: 1,
  },
  {
    name: 'synthetic MCP credentials',
    args: [
      '--test',
      'apps_connections',
      'real_mcp_catalog_and_private_credentials_preserve_roles_and_scope',
    ],
    minimum: 1,
  },
];

export function verifiedTestCount(output, minimum) {
  const summaries = [
    ...output.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; .*$/gm),
  ];
  assert.equal(summaries.length, 1, 'Expected exactly one completed Rust test suite.');
  const [, passed, failed, ignored] = summaries[0].map(Number);
  assert.ok(passed >= minimum, `Expected at least ${minimum} executed tests, received ${passed}.`);
  assert.equal(failed, 0, 'Rust test failures cannot qualify the foundation.');
  assert.equal(ignored, 0, 'Ignored tests cannot qualify the foundation.');
  return passed;
}

export function checkWindowsFoundation({
  platform = process.platform,
  arch = process.arch,
  run = spawnSync,
  print = console.log,
} = {}) {
  assert.equal(platform, 'win32', 'Run the foundation checks on native Windows.');
  assert.equal(arch, 'x64', 'Run the foundation checks with x64 Node.');
  const checks = [];
  for (const suite of foundationSuites) {
    print(`Windows foundation: ${suite.name}`);
    const result = run(
      process.execPath,
      [runner, ...suite.args, '--', '--format=terse', '--color=never'],
      {
        cwd: root,
        env: { ...process.env, CARGO_TERM_COLOR: 'never' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 25 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.stdout) print(result.stdout);
    if (result.stderr) print(result.stderr);
    assert.ok(!result.error && result.status === 0, `Windows foundation failed: ${suite.name}.`);
    checks.push({
      name: suite.name,
      passed: verifiedTestCount(result.stdout ?? '', suite.minimum),
    });
  }
  return {
    platform,
    architecture: arch,
    scope:
      'Native configuration and credential persistence; Windows releases remain connection clients.',
    checks,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, 'The foundation check does not accept options.');
    console.log(JSON.stringify(checkWindowsFoundation(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { browserEnvironment } from '../browser-environment.js';

test('work-browser child receives display/runtime essentials but never control credentials or execution hooks', () => {
  const source = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    DISPLAY: ':13',
    TMPDIR: '/tmp',
    HOME: '/private/host-home',
    USERPROFILE: '/private/host-home',
    OPENBOT_WORKER_TOKEN: 'synthetic-worker-token',
    OPENAI_API_KEY: 'synthetic-model-key',
    CUBE_API_KEY: 'synthetic-cube-key',
    AWS_SECRET_ACCESS_KEY: 'synthetic-cloud-key',
    SSH_AUTH_SOCK: '/private/ssh.sock',
    NODE_OPTIONS: '--require /private/hook.cjs',
    LD_PRELOAD: '/private/hook.so',
    DYLD_INSERT_LIBRARIES: '/private/hook.dylib',
    HTTPS_PROXY: 'https://secret:proxy@private.example.test',
    XDG_CONFIG_HOME: '/private/config',
    OPENBOT_BROWSER_EXECUTABLE: '/private/chrome',
    UNKNOWN_SECRET: 'synthetic-custom-secret',
  };
  const before = structuredClone(source);
  const env = browserEnvironment('data/browser-environment-fixture', source);
  const child = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    {
      env,
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const inherited = JSON.parse(child.stdout);
  // macOS can initialize this system locale value in the child itself.
  if (process.platform === 'darwin') delete inherited.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(inherited, {
    PATH: source.PATH,
    LANG: source.LANG,
    DISPLAY: source.DISPLAY,
    TMPDIR: source.TMPDIR,
    HOME: resolve('data/browser-environment-fixture'),
    USERPROFILE: resolve('data/browser-environment-fixture'),
  });
  assert.deepEqual(source, before);
});

test('browser environment supports Windows casing without allowing secret-like locale variables', () => {
  const env = browserEnvironment('data/browser-fixture', {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\cmd.exe',
    LC_CTYPE: 'en_US.UTF-8',
    LC_API_KEY: 'synthetic',
    TEMP: 'bad\0path',
  });
  assert.equal(env.Path, 'C:\\Windows\\System32');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ComSpec, 'C:\\Windows\\cmd.exe');
  assert.equal(env.LC_CTYPE, 'en_US.UTF-8');
  assert.equal(env.LC_API_KEY, undefined);
  assert.equal(env.TEMP, undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDevelopment, readyPort } from './dev.js';
import { backendLaunch } from './backend-launch.mjs';
import { spawnService, serviceApiConfig } from './computerServices/system.js';
import { loadServicesConfig, type ServicesConfig } from './computerServices/config.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-startup-'));
  const binary = join(directory, 'synthetic-backend');
  const configFile = join(directory, 'server.private.json');
  await writeFile(
    configFile,
    JSON.stringify({
      dataDir: directory,
      bind: '127.0.0.1:41001',
      publicOrigin: 'https://service.example.test',
      webOrigin: 'http://127.0.0.1:5173',
    }),
    { mode: 0o600 },
  );
  await writeFile(
    binary,
    `#!${process.execPath}\n` +
      `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify(args));
if (process.env.FIXTURE_PID) fs.writeFileSync(process.env.FIXTURE_PID, String(process.pid));
if (process.env.FIXTURE_IGNORE_TERM) process.on('SIGTERM', () => {});
const index = args.indexOf('--config');
const config = index >= 0 ? JSON.parse(fs.readFileSync(args[index + 1])) : {};
const bindIndex = args.indexOf('--bind');
const address = process.env.FIXTURE_ADDRESS || (bindIndex >= 0 ? args[bindIndex + 1] : config.bind);
const operationsAddress = process.env.FIXTURE_OPERATIONS_ADDRESS;
process.stdout.write(JSON.stringify({ type: 'openbot:ready', backend: 'rust', address, operationsAddress }) + '\\n');
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    OPENBOT_BACKEND_BINARY: binary,
    OPENBOT_SERVER_CONFIG: configFile,
    FIXTURE_CAPTURE: join(directory, 'arguments.json'),
  };
  const config: ServicesConfig = {
    version: 1,
    ports: { api: 41001, cubeApi: 41002, cubeProxy: 41003, bridge: 41004, cubeApiTarget: 41005 },
    dataDir: directory,
    serverConfigPath: configFile,
    cubeConfigPath: join(directory, 'cube.json'),
    connectionPath: join(directory, 'connection.json'),
    ssh: {
      host: 'fixture.example.test',
      user: 'fixture',
      port: 22,
      controlPath: join(directory, 'control'),
    },
  };
  return {
    directory,
    binary,
    configFile,
    env,
    config,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

async function end(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  await ended;
}

test('development proxy uses the actual Rust ready address for default, explicit config and explicit data arguments', async () => {
  const f = await fixture();
  try {
    for (const args of [
      ['--init-operator'],
      ['--config', f.configFile, '--init-operator'],
      ['--data-dir', f.directory, '--bind', '127.0.0.1:43127', '--init-operator'],
    ]) {
      const stop = new AbortController();
      const launched: {
        executable: string;
        args: string[];
        options: SpawnOptions;
        child: ChildProcess;
      }[] = [];
      let started!: () => void;
      const web = new Promise<void>((done) => {
        started = done;
      });
      const running = runDevelopment({
        args,
        env: { ...f.env, OPENBOT_BIND_HOST: 'wrong.example.test' },
        build: async () => {},
        signal: stop.signal,
        launch: (executable, argv, options) => {
          const child =
            launched.length === 0
              ? spawn(executable, argv, options)
              : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          launched.push({ executable, args: [...argv], options, child });
          if (launched.length === 2) started();
          return child;
        },
        startupMs: 3000,
      });
      await web;
      stop.abort();
      assert.equal(await running, 0);
      assert.equal(
        launched[0].executable,
        f.binary,
        'supervisor holds the real backend process, not a Node launcher',
      );
      const actual = JSON.parse(await readFile(f.env.FIXTURE_CAPTURE, 'utf8'));
      assert.deepEqual(
        actual,
        args[0] === '--init-operator' ? ['--config', f.configFile, '--init-operator'] : args,
      );
      assert.equal(launched[1].options.env?.PORT, args.includes('--bind') ? '43127' : '41001');
      assert.equal(launched[1].options.env?.OPENBOT_BIND_HOST, '127.0.0.1');
      assert.equal(
        launched.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
        true,
      );
    }
  } finally {
    await f.close();
  }
});

test('invalid or non-Rust readiness cannot start Vite and a cancelled build cannot start a writer', async () => {
  for (const address of [
    '0.0.0.0:41001',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:41001/path',
    '[::1]:41001',
  ])
    assert.throws(() => readyPort({ type: 'openbot:ready', backend: 'rust', address }));
  assert.throws(() =>
    readyPort({ type: 'openbot:ready', backend: 'node', address: '127.0.0.1:41001' }),
  );
  assert.equal(readyPort({ type: 'log', address: '127.0.0.1:41001' }), undefined);
  const f = await fixture();
  try {
    const children: ChildProcess[] = [];
    assert.equal(
      await runDevelopment({
        env: { ...f.env, FIXTURE_ADDRESS: '0.0.0.0:41001' },
        build: async () => {},
        launch: (file, args, options) => {
          const child = spawn(file, args, options);
          children.push(child);
          return child;
        },
        startupMs: 3000,
      }),
      1,
    );
    assert.equal(children.length, 1);
    assert.ok(children[0].signalCode || children[0].exitCode !== null);
    const stop = new AbortController();
    let complete!: () => void;
    const build = new Promise<void>((done) => {
      complete = done;
    });
    const run = runDevelopment({
      env: f.env,
      build: () => build,
      signal: stop.signal,
      launch: () => assert.fail('cancelled build started a writer'),
    });
    stop.abort();
    complete();
    assert.equal(await run, 0);
  } finally {
    await f.close();
  }
});

test('cleanup deadline waits for the actual backend after a synthetic writer ignores graceful termination', async () => {
  const f = await fixture();
  const stop = new AbortController();
  let actual: ChildProcess | undefined;
  try {
    const result = runDevelopment({
      env: { ...f.env, FIXTURE_IGNORE_TERM: '1' },
      build: async () => {},
      signal: stop.signal,
      cleanupMs: 30,
      startupMs: 3000,
      launch: (file, args, options) => {
        if (!actual) {
          actual = spawn(file, args, options);
          return actual;
        }
        const web = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        stop.abort();
        return web;
      },
    });
    assert.equal(await result, 0);
    assert.equal(actual?.signalCode, 'SIGKILL');
    assert.throws(
      () => process.kill(actual!.pid!, 0),
      (error: any) => error.code === 'ESRCH',
    );
  } finally {
    await f.close();
  }
});

test('computer services share the Rust launch contract, preserve private origins, and never start on mismatched config', async () => {
  const f = await fixture();
  try {
    const launches: { file: string; args: string[]; options: SpawnOptions }[] = [];
    const launch = ((file: string, args: string[], options: SpawnOptions) => {
      launches.push({ file, args, options });
      return spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    }) as typeof spawn;
    const child = spawnService('api', f.config, { env: f.env, launch });
    await once(child.stdout!, 'data');
    await end(child);
    assert.equal(launches[0].file, f.binary);
    assert.deepEqual(launches[0].args, ['--config', f.configFile]);
    assert.equal(
      JSON.parse(await readFile(f.configFile, 'utf8')).publicOrigin,
      'https://service.example.test',
    );
    assert.equal(
      serviceApiConfig({ ...f.config, serverConfigPath: undefined }, f.env),
      f.configFile,
    );
    const mismatched = join(f.directory, 'different.private.json');
    for (const value of [
      { dataDir: f.directory, bind: '127.0.0.1:3002' },
      { dataDir: join(f.directory, 'other'), bind: '127.0.0.1:41001' },
    ]) {
      await writeFile(mismatched, JSON.stringify(value), { mode: 0o600 });
      assert.throws(
        () =>
          spawnService(
            'api',
            { ...f.config, serverConfigPath: mismatched },
            { env: f.env, launch },
          ),
        (error: any) => error.code === 'SERVER_CONFIG_MISMATCH',
      );
    }
    await chmod(f.configFile, 0o644);
    assert.throws(() => spawnService('api', f.config, { env: f.env, launch }));
    await chmod(f.configFile, 0o600);
    const linked = join(f.directory, 'linked.json');
    await symlink(f.configFile, linked);
    assert.throws(() =>
      spawnService('api', { ...f.config, serverConfigPath: linked }, { env: f.env, launch }),
    );
    assert.equal(
      launches.length,
      1,
      'invalid private configuration is rejected before creating a process',
    );
    let bridge: { args: readonly string[]; options: SpawnOptions } | undefined;
    spawnService('bridge', f.config, {
      env: { ...f.env, PRIVATE_FIXTURE_KEY: 'must-not-leave-parent' },
      launch: ((file: string, args: readonly string[], options: SpawnOptions) => {
        bridge = { args, options };
        assert.equal(file, process.execPath);
        return child;
      }) as typeof spawn,
    });
    assert.deepEqual(bridge!.args, [
      '--import',
      'tsx',
      'scripts/cube-worker-bridge.ts',
      '--config',
      f.config.cubeConfigPath,
    ]);
    assert.equal(bridge!.options.env?.PRIVATE_FIXTURE_KEY, undefined);
    assert.equal(bridge!.options.env?.OPENBOT_BACKEND_BINARY, undefined);
  } finally {
    await f.close();
  }
});

test('old Node commands are explicitly rejected and services accept only a fixed private server-config path', async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        backendLaunch(['--data-dir', f.directory], {
          ...f.env,
          OPENBOT_BACKEND_BINARY: join(f.directory, 'server/index.ts'),
        }),
      /former Node business server/,
    );
    const path = join(f.directory, 'services.json');
    await writeFile(path, JSON.stringify(f.config), { mode: 0o600 });
    assert.deepEqual(await loadServicesConfig(path), f.config);
    await writeFile(path, JSON.stringify({ ...f.config, command: 'server/index.ts' }));
    await assert.rejects(loadServicesConfig(path), (error: any) => error.code === 'CONFIG_INVALID');
    await writeFile(path, JSON.stringify({ ...f.config, serverConfigPath: 'relative.json' }));
    await assert.rejects(loadServicesConfig(path), (error: any) => error.code === 'CONFIG_INVALID');
  } finally {
    await f.close();
  }
});

test('the public backend launcher forwards init-operator and waits for its real writer on termination', async () => {
  const f = await fixture();
  const pidFile = join(f.directory, 'writer-pid');
  const child = spawn(
    process.execPath,
    ['scripts/start-backend.mjs', '--config', f.configFile, '--init-operator'],
    {
      env: { ...f.env, FIXTURE_PID: pidFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await once(child.stdout!, 'data');
    assert.deepEqual(JSON.parse(await readFile(f.env.FIXTURE_CAPTURE, 'utf8')), [
      '--config',
      f.configFile,
      '--init-operator',
    ]);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await end(child);
    assert.throws(
      () => process.kill(pid, 0),
      (error: any) => error.code === 'ESRCH',
    );
  } finally {
    await end(child);
    await f.close();
  }
});

test('development starts a separate operations site from validated Rust readiness and stops every owned process', async () => {
  const f = await fixture();
  try {
    for (const address of ['127.0.0.1:43128', '0.0.0.0:43128', '127.0.0.1:41001']) {
      const valid = address === '127.0.0.1:43128';
      const stop = new AbortController();
      const launched: { args: string[]; options: SpawnOptions; child: ChildProcess }[] = [];
      const result = await runDevelopment({
        env: { ...f.env, FIXTURE_OPERATIONS_ADDRESS: address },
        build: async () => {},
        signal: stop.signal,
        startupMs: 3000,
        launch: (file, args, options) => {
          const child =
            launched.length === 0
              ? spawn(file, args, options)
              : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          launched.push({ args: [...args], options, child });
          if (launched.length === 3) stop.abort();
          return child;
        },
      });
      assert.equal(result, valid ? 0 : 1);
      assert.equal(launched.length, valid ? 3 : 1);
      if (valid) {
        assert.deepEqual(launched[1].args.slice(-2), ['--config', 'web/vite.config.ts']);
        assert.equal(launched[1].options.env?.PORT, '41001');
        assert.deepEqual(launched[2].args.slice(-2), ['--config', 'operations/vite.config.ts']);
        assert.equal(launched[2].options.env?.PORT, '43128');
        assert.equal(launched[2].options.env?.OPENBOT_OPERATIONS_API_PORT, '43128');
        assert.equal(launched[2].options.env?.OPENBOT_BIND_HOST, '127.0.0.1');
      }
      assert.ok(
        launched.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
      );
    }
  } finally {
    await f.close();
  }
});

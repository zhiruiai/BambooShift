'use strict';
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir, userInfo } = require('node:os');
const { isAbsolute, join } = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');

const bundleName = 'bambooshift-runtime';
const localPartition = 'persist:openbot-managed-local';
const profileMarker = 'local-workspace.selected';
const maxLineBytes = 4096;

function checkedPath(root, path, directory = false) {
  let file = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    const stat = lstatSync(file);
    const expectedDirectory = directory || index < parts.length - 1;
    if (expectedDirectory ? !stat.isDirectory() : !stat.isFile())
      throw Error('Invalid runtime path');
  }
  return file;
}

function runtimeBundle(resourcesPath, platform, architecture) {
  if (!['darwin', 'linux'].includes(platform) || !resourcesPath || !isAbsolute(resourcesPath))
    return undefined;
  try {
    const root = checkedPath(resourcesPath, bundleName, true);
    const manifest = checkedPath(root, 'desktop-runtime.json');
    if (lstatSync(manifest).size > maxLineBytes) return undefined;
    const spec = JSON.parse(readFileSync(manifest, 'utf8'));
    if (
      spec.version !== 1 ||
      spec.platform !== platform ||
      spec.architecture !== architecture ||
      spec.server !== 'openbot-backend' ||
      spec.node !== 'bin/node' ||
      spec.runtime !== 'runtime'
    )
      return undefined;
    const server = checkedPath(root, spec.server);
    const node = checkedPath(root, spec.node);
    const imageWorker = checkedPath(root, 'openbot-image-worker');
    const runtime = checkedPath(root, spec.runtime, true);
    for (const binary of [server, node, imageWorker]) accessSync(binary, constants.X_OK);
    checkedPath(runtime, 'dist/index.html');
    checkedPath(runtime, 'node_modules', true);
    for (const name of ['pi', 'computer', 'document', 'mcp'])
      checkedPath(runtime, `packages/${name}-worker/index.mjs`);
    let cua;
    if (platform === 'darwin' && spec.hostControl === true) {
      try {
        const driver = checkedPath(root, 'bin/cua-driver');
        accessSync(driver, constants.X_OK);
        cua = driver;
      } catch {
        // The local workspace remains usable when this optional driver is missing.
      }
    }
    return { root, server, node, runtime, cua };
  } catch {
    return undefined;
  }
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())
    throw Error('Invalid private workspace directory');
  return path;
}

function writeConfig(dataDir, bundle, token, desktopDriver) {
  const profile = privateDirectory(join(dataDir, 'local-workspace'));
  const data = privateDirectory(join(profile, 'data'));
  const target = join(profile, 'service.json');
  const temp = join(profile, `service-${randomUUID()}.tmp`);
  try {
    writeFileSync(
      temp,
      JSON.stringify({
        dataDir: data,
        bind: '127.0.0.1:0',
        runtimeDir: bundle.runtime,
        nodeBinary: bundle.node,
        localDesktop: {
          bootstrapToken: token,
          ...(desktopDriver ? { hostControl: true, desktopDriver } : {}),
        },
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    renameSync(temp, target);
    return target;
  } finally {
    rmSync(temp, { force: true });
  }
}

function managedOrigin(line) {
  const ready = JSON.parse(line);
  const port =
    typeof ready.address === 'string' && /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(ready.address);
  if (
    ready.type !== 'openbot:ready' ||
    ready.backend !== 'rust' ||
    !port ||
    +port[1] > 65535 ||
    Object.keys(ready).some((key) => !['type', 'backend', 'address'].includes(key))
  )
    throw Error('Invalid local runtime handshake');
  return `http://127.0.0.1:${port[1]}`;
}

function readLocalSelection(dataDir) {
  try {
    const marker = join(dataDir, profileMarker);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.size > 256) return undefined;
    if (
      process.platform !== 'win32' &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    )
      return undefined;
    const value = readFileSync(marker, 'utf8');
    if (value === '1\n') return { hostControl: false };
    const selected = JSON.parse(value);
    if (selected.version === 1 && typeof selected.hostControl === 'boolean')
      return { hostControl: selected.hostControl };
  } catch {
    // Missing or invalid preference leaves the workspace choice open.
  }
  return undefined;
}

function saveLocalSelection(dataDir, selected) {
  const marker = join(dataDir, profileMarker);
  const temp = join(dataDir, `local-selection-${randomUUID()}.tmp`);
  try {
    if (!selected) rmSync(marker, { force: true });
    else {
      writeFileSync(
        temp,
        JSON.stringify({ version: 1, hostControl: selected.hostControl === true }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      renameSync(temp, marker);
    }
  } catch {
    // Selecting a workspace still works if the profile is read-only.
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {}
  }
}

function runtimeEnvironment(hostControl = false) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: tmpdir() };
  if (!hostControl) return env;
  const { homedir, username } = userInfo();
  return {
    ...env,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: homedir,
    USER: username,
    LOGNAME: username,
  };
}

async function startCuaHost(executablePath, { signal, timeoutMs }) {
  signal.throwIfAborted();
  // Unix sockets have a short path limit on macOS. The random directory is owner-only.
  const directory = mkdtempSync('/tmp/bambooshift-cua-');
  const socketPath = join(directory, 'driver.sock');
  let child, closed, stopPromise;
  const stop = () => {
    stopPromise ??= (async () => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
          try {
            await closed;
          } finally {
            clearTimeout(force);
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    })();
    return stopPromise;
  };
  try {
    child = spawn(
      executablePath,
      ['serve', '--embedded', '--socket', socketPath, '--pid-file', join(directory, 'driver.pid')],
      {
        cwd: directory,
        env: {
          ...runtimeEnvironment(),
          CUA_DRIVER_EMBEDDED: '1',
          CUA_DRIVER_HOST_BUNDLE_ID: 'com.openbot.client',
          CUA_DRIVER_PERMISSION_MODE: 'standard',
        },
        stdio: 'ignore',
      },
    );
    let exited = false;
    closed = new Promise((done) => {
      child.once('close', () => {
        exited = true;
        done();
      });
      child.on('error', () => {
        exited = true;
      });
    });
    const deadline = Date.now() + timeoutMs;
    while (!exited && Date.now() < deadline) {
      signal.throwIfAborted();
      const socket = lstatSync(socketPath, { throwIfNoEntry: false });
      if (socket?.isSocket() && socket.uid === process.getuid() && (socket.mode & 0o077) === 0)
        return { stop, driver: { kind: 'cua', executablePath, socketPath } };
      await pause(25, undefined, { signal });
    }
    throw Error('localHostControlFailed');
  } catch (error) {
    await stop();
    throw error;
  }
}

function createLocalRuntime({
  resourcesPath,
  dataDir,
  platform = process.platform,
  architecture = process.arch,
  startTimeoutMs = 25_000,
  stopTimeoutMs = 5_000,
}) {
  let current, pendingHost;
  function stop(job = current) {
    if (!job) {
      pendingHost?.controller.abort();
      return pendingHost?.ready.then(
        () => {},
        () => {},
      );
    }
    if (!job.stopping && !job.closed) {
      job.stopping = true;
      job.child.kill('SIGTERM');
      job.killTimer = setTimeout(() => {
        try {
          if (job.child.pid) process.kill(-job.child.pid, 'SIGKILL');
        } catch {
          job.child.kill('SIGKILL');
        }
      }, stopTimeoutMs);
    }
    return job.done;
  }

  async function start({ signal, onExit, hostControl = false }) {
    if (current || pendingHost) await stop();
    signal.throwIfAborted();
    const bundle = runtimeBundle(resourcesPath, platform, architecture);
    if (!bundle) throw Error('localRuntimeUnavailable');
    let host;
    if (hostControl) {
      if (!bundle.cua) throw Error('localHostControlUnavailable');
      const controller = new AbortController();
      const pending = {
        controller,
        ready: startCuaHost(bundle.cua, {
          signal: AbortSignal.any([signal, controller.signal]),
          timeoutMs: Math.min(startTimeoutMs, 8_000),
        }),
      };
      pendingHost = pending;
      try {
        host = await pending.ready;
      } finally {
        if (pendingHost === pending) pendingHost = undefined;
      }
    }
    let child;
    const token = randomBytes(32).toString('hex');
    try {
      signal.throwIfAborted();
      const config = writeConfig(dataDir, bundle, token, host?.driver);
      child = spawn(bundle.server, ['--config', config], {
        cwd: bundle.root,
        detached: true,
        env: runtimeEnvironment(Boolean(host)),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      await host?.stop();
      throw error;
    }
    const job = { child };
    current = job;
    job.done = new Promise((done) => {
      child.once('close', () => {
        job.closed = true;
        clearTimeout(job.killTimer);
        if (!job.stopping) onExit();
        Promise.resolve(host?.stop())
          .catch(() => {})
          .finally(() => {
            if (current === job) current = undefined;
            done();
          });
      });
    });

    try {
      const origin = await new Promise((ready, fail) => {
        let line = Buffer.alloc(0);
        const finish = (error, value) => {
          clearTimeout(timeout);
          child.stdout.off('data', read);
          child.stdout.resume();
          signal.removeEventListener('abort', abort);
          child.off('close', close);
          if (error) fail(error);
          else ready(value);
        };
        const abort = () => finish(signal.reason);
        const close = () => finish(Error('localRuntimeFailed'));
        const timeout = setTimeout(() => finish(Error('localRuntimeTimeout')), startTimeoutMs);
        const read = (chunk) => {
          const newline = chunk.indexOf(10);
          const part = newline < 0 ? chunk : chunk.subarray(0, newline);
          if (line.length + part.length > maxLineBytes) return close();
          line = Buffer.concat([line, part]);
          if (newline < 0) return;
          try {
            finish(undefined, managedOrigin(line.toString('utf8')));
          } catch {
            close();
          }
        };
        child.stdout.on('data', read);
        child.once('error', close);
        child.once('close', close);
        signal.addEventListener('abort', abort, { once: true });
      });
      signal.throwIfAborted();
      if (job.stopping || job.closed) throw Error('localRuntimeFailed');
      return { origin, token };
    } catch (error) {
      await stop(job);
      throw error;
    }
  }

  return {
    available: () => Boolean(runtimeBundle(resourcesPath, platform, architecture)),
    hostControlAvailable: () => Boolean(runtimeBundle(resourcesPath, platform, architecture)?.cua),
    start,
    stop,
  };
}

async function authenticateLocalSession(session, origin, token, signal) {
  const url = origin + '/api/account/local-session';
  const response = await session.fetch(url, {
    method: 'POST',
    credentials: 'include',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-BambooShift-Local-Token': token,
    },
    body: '{}',
    signal,
  });
  if (
    !response.ok ||
    response.redirected ||
    (response.url && response.url !== url) ||
    signal.aborted ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    throw Error('localRuntimeFailed');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) throw Error('localRuntimeFailed');
      chunks.push(value);
    }
    signal.throwIfAborted();
    const { authenticated, workspaceId, user } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      authenticated !== true ||
      user?.localOnly !== true ||
      typeof workspaceId !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(workspaceId)
    )
      throw Error('localRuntimeFailed');
    return '/w/' + workspaceId;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function installRuntimeQuit(app, close) {
  let waiting = false;
  app.on('before-quit', (event) => {
    const stopped = close();
    if (!stopped) return;
    event.preventDefault();
    if (waiting) return;
    waiting = true;
    void stopped.finally(() => app.quit());
  });
}

module.exports = {
  createLocalRuntime,
  authenticateLocalSession,
  localPartition,
  readLocalSelection,
  saveLocalSelection,
  installRuntimeQuit,
};

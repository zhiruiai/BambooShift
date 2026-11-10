import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isComputerOperationId } from '../shared/computer-operations.ts';
import {
  COMPUTER_WORKER_PROTOCOL,
  workerControlOrigin,
} from '../server/workers/computer-worker/protocol.ts';
import { DEFAULT_DESKTOP_HELPER } from '../server/workers/computer-runtime/desktop.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const usage =
  'Usage: npm run computer:pair -- --workspace <UUID> [--origin <HTTPS origin>] [--desktop]';
const inherited = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  '__CF_USER_TEXT_ENCODING',
];

function pairingOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: 'string' },
      origin: { type: 'string' },
      desktop: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return null;
  if (!isComputerOperationId(values.workspace)) throw new Error(usage);
  if (values.desktop && process.platform !== 'darwin')
    throw new Error('Native desktop pairing requires macOS.');
  return {
    workspace: values.workspace,
    origin: workerControlOrigin(values.origin),
    desktop: values.desktop === true,
  };
}

async function privateDirectory(directory, permittedMode) {
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    (process.getuid && (metadata.uid !== process.getuid() || metadata.mode & permittedMode))
  ) {
    throw new Error('The computer workspace must be an owner-controlled directory.');
  }
}

function startWorker(options, directory, token) {
  const env = Object.fromEntries(
    inherited.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  Object.assign(env, {
    OPENBOT_WORKER_HOST: '127.0.0.1',
    OPENBOT_WORKER_PORT: '0',
    OPENBOT_WORKER_TOKEN: token,
    OPENBOT_WORKER_WORKSPACE_ID: options.workspace,
    OPENBOT_WORKER_WORKSPACE: directory,
    ...(options.origin ? { OPENBOT_PUBLIC_ORIGIN: options.origin } : {}),
    ...(options.desktop ? { OPENBOT_WORKER_ALLOW_HOST_DESKTOP: 'true' } : {}),
  });
  return spawn(process.execPath, ['--import', 'tsx', 'scripts/computer-worker.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

async function pair(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Use an interactive terminal to receive the temporary pairing token.');
  if (options.desktop) {
    try {
      await access(DEFAULT_DESKTOP_HELPER, constants.X_OK);
    } catch {
      throw new Error('Build the Mac desktop helper first with npm run desktop:build.');
    }
  }
  await privateDirectory(resolve(root, 'data'), 0o022);
  await privateDirectory(resolve(root, 'data/paired-computers'), 0o077);
  const directory = resolve(root, 'data/paired-computers', options.workspace);
  await privateDirectory(directory, 0o077);
  const workspace = resolve(directory, 'workspace');
  await privateDirectory(workspace, 0o077);
  const lock = resolve(directory, 'active.lock');
  let lease;
  try {
    lease = await open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'This workspace already has a pairing session. Stop it before pairing again.',
      );
    throw error;
  }
  try {
    await runPairingSession(options, workspace);
  } finally {
    await lease.close();
    await unlink(lock);
  }
}

async function runPairingSession(options, workspace) {
  const token = randomBytes(32).toString('base64url');
  const child = startWorker(options, workspace, token);
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise((done) => {
    child.once('error', () => done(1));
    child.once('close', (code) => done(code ?? 1));
  });
  const listening = new Promise((done) => {
    lines.on('line', (line) => {
      const match = /^OpenBot Computer Worker: (http:\/\/127\.0\.0\.1:\d{1,5})$/.exec(line);
      if (match) done(match[1]);
    });
  });
  let deadline, escalation;
  function stop() {
    if (child.exitCode !== null || child.signalCode !== null || escalation) return;
    child.kill('SIGTERM');
    escalation = setTimeout(() => child.kill('SIGKILL'), 8000);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.platform !== 'win32') process.on('SIGHUP', stop);
  try {
    const url = await Promise.race([
      listening,
      exited.then(() => null),
      new Promise((done) => {
        deadline = setTimeout(() => done(null), 15000);
      }),
    ]);
    clearTimeout(deadline);
    if (!url) throw new Error('The work computer did not start.');
    const response = await fetch(`${url}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const health = response.ok ? await response.json() : null;
    if (
      health?.protocol !== COMPUTER_WORKER_PROTOCOL ||
      health.workspaceScopeId !== options.workspace ||
      health.controlOrigin !== options.origin
    )
      throw new Error('The work computer could not verify its workspace and control origin.');
    console.log(`Computer address: ${url}\nPairing token: ${token}`);
    console.log('Keep this terminal open. Stop the session with Ctrl+C to invalidate this token.');
    const code = await exited;
    if (!escalation && code) throw new Error('The work computer stopped unexpectedly.');
  } finally {
    clearTimeout(deadline);
    stop();
    await exited;
    clearTimeout(escalation);
    lines.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (process.platform !== 'win32') process.off('SIGHUP', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = pairingOptions(process.argv.slice(2));
    if (options) await pair(options);
    else console.log(usage);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Computer pairing failed.');
    process.exitCode = 1;
  }
}

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { cargo, root } from './rust-toolchain.mjs';
import { launchBackend } from './backend-launch.mjs';

export function readyPort(message: unknown, field = 'address'): string | undefined {
  if (
    !message ||
    typeof message !== 'object' ||
    !('type' in message) ||
    message.type !== 'openbot:ready'
  )
    return;
  const value = message as Record<string, unknown>;
  if (value.backend !== 'rust' || typeof value[field] !== 'string')
    throw new Error('The backend did not identify a Rust loopback listener.');
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value[field] as string);
  if (!match || Number(match[1]) > 65535)
    throw new Error('Local development requires an actual loopback IPv4 listener.');
  return match[1];
}

type Launch = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
export async function runDevelopment({
  args = process.argv.slice(2),
  env = process.env,
  build = () => cargo('build', ['--bins']),
  launch = spawn as Launch,
  signal,
  startupMs = 60_000,
  cleanupMs = 15_000,
}: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  build?: () => Promise<void>;
  launch?: Launch;
  signal?: AbortSignal;
  startupMs?: number;
  cleanupMs?: number;
} = {}): Promise<number> {
  const children: ChildProcess[] = [];
  let stopping = false,
    exitCode = 0;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((done) => {
    resolveStop = done;
  });
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    resolveStop();
  };
  const abort = () => stop();
  const onSignal = () => stop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  signal?.addEventListener('abort', abort, { once: true });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let output: ReturnType<typeof createInterface> | undefined;
  const observe = (child: ChildProcess) => {
    children.push(child);
    child.once('error', (error) => {
      console.error(error.message);
      stop(1);
    });
    child.once('exit', (code) => stop(code ?? 1));
    return child;
  };
  try {
    if (signal?.aborted) return 0;
    await build();
    if (stopping) return exitCode;
    const backend = observe(
      launchBackend(args, { env, launch, stdio: ['inherit', 'pipe', 'inherit'] }),
    );
    deadline = setTimeout(() => {
      console.error('The Rust backend did not become ready within the startup deadline.');
      stop(1);
    }, startupMs);
    if (!backend.stdout) throw new Error('The backend readiness stream is unavailable.');
    output = createInterface({ input: backend.stdout });
    let webStarted = false;
    output.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        console.log(line);
        return;
      }
      if (stopping || webStarted) return;
      let port: string | undefined;
      let operationsPort: string | undefined;
      try {
        port = readyPort(message);
        if (port && message.operationsAddress != null) {
          operationsPort = readyPort(message, 'operationsAddress');
          if (operationsPort === port)
            throw new Error('Product and operations must use different listeners.');
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Invalid backend readiness.');
        stop(1);
        return;
      }
      if (!port) return;
      webStarted = true;
      clearTimeout(deadline);
      observe(
        launch(
          process.execPath,
          [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', 'web/vite.config.ts'],
          {
            cwd: root,
            stdio: 'inherit',
            env: { ...env, PORT: port, OPENBOT_BIND_HOST: '127.0.0.1' },
          },
        ),
      );
      if (operationsPort)
        observe(
          launch(
            process.execPath,
            [
              resolve(root, 'node_modules/vite/bin/vite.js'),
              '--config',
              'operations/vite.config.ts',
            ],
            {
              cwd: root,
              stdio: 'inherit',
              env: {
                ...env,
                PORT: operationsPort,
                OPENBOT_OPERATIONS_API_PORT: operationsPort,
                OPENBOT_BIND_HOST: '127.0.0.1',
              },
            },
          ),
        );
    });
    await stopped;
    return exitCode;
  } catch (error) {
    if (!stopping) throw error;
    return exitCode;
  } finally {
    clearTimeout(deadline);
    output?.close();
    const waits = children.map((child) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve();
      return new Promise<void>((done) => child.once('exit', () => done()));
    });
    children.forEach((child) => child.kill('SIGTERM'));
    const force = setTimeout(() => {
      // These handles refer directly to Rust and Vite, never an intermediate launcher.
      children.forEach((child) => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
    }, cleanupMs);
    await Promise.all(waits);
    clearTimeout(force);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    signal?.removeEventListener('abort', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDevelopment();
}

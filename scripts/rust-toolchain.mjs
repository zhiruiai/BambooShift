import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableRustEnvironment } from './rust-portable.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));
function installedTool(name) {
  const rustup = spawnSync('rustup', ['which', '--toolchain', 'stable', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (rustup.status === 0 && existsSync(rustup.stdout.trim())) return rustup.stdout.trim();
  const local = join(homedir(), '.cargo', 'bin', name);
  if (existsSync(local)) return local;
  const toolchains = join(homedir(), '.rustup', 'toolchains');
  if (existsSync(toolchains)) {
    const stable = readdirSync(toolchains).find(
      (entry) => entry.startsWith('stable-') && existsSync(join(toolchains, entry, 'bin', name)),
    );
    if (stable) return join(toolchains, stable, 'bin', name);
  }
  return name;
}
export function rustEnvironment({ portable = false } = {}) {
  const env = { ...process.env };
  if (!env.CARGO_HOME && existsSync(join(root, '.tools/cargo/registry')))
    env.CARGO_HOME = join(root, '.tools/cargo');
  env.CARGO_TARGET_DIR ||= join(root, '.build/rust');
  env.RUSTC ||= installedTool('rustc');
  env.RUSTDOC ||= installedTool('rustdoc');
  env.PATH = `${resolve(process.execPath, '..')}${delimiter}${env.PATH ?? ''}`;
  return portable ? portableRustEnvironment(env, root) : env;
}
export function rustBinary(name = 'openbot-backend', release = false, options = {}) {
  return join(
    rustEnvironment(options).CARGO_TARGET_DIR,
    release ? 'release' : 'debug',
    `${name}${process.platform === 'win32' ? '.exe' : ''}`,
  );
}
export async function cargo(operation, args = [], options = {}) {
  const child = spawn(
    process.env.OPENBOT_CARGO || installedTool('cargo'),
    [
      operation,
      '--locked',
      ...(process.env.OPENBOT_CARGO_OFFLINE === '1' ? ['--offline'] : []),
      '--manifest-path',
      join(root, 'server/api/Cargo.toml'),
      ...args,
    ],
    { cwd: root, env: rustEnvironment(options), stdio: 'inherit' },
  );
  const signals = ['SIGINT', 'SIGTERM'];
  const forward = (signal) => child.kill(signal);
  const handlers = signals.map((signal) => {
    const handler = () => forward(signal);
    process.on(signal, handler);
    return handler;
  });
  try {
    await new Promise((yes, no) => {
      child.once('error', no);
      child.once('exit', (code, signal) =>
        code === 0 ? yes() : no(new Error(`Rust ${operation} failed (${code ?? signal}).`)),
      );
    });
  } finally {
    signals.forEach((signal, i) => process.off(signal, handlers[i]));
  }
}

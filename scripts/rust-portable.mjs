import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function portableRustEnvironment(environment, root, home = homedir()) {
  const env = { ...environment };
  const flags = env.CARGO_ENCODED_RUSTFLAGS
    ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
    : (env.RUSTFLAGS || '').trim().split(/\s+/).filter(Boolean);
  const mappings = new Map([
    [resolve(home), '/builder'],
    [resolve(root), '/openbot'],
    [resolve(env.CARGO_HOME || join(home, '.cargo')), '/cargo'],
    [resolve(env.RUSTUP_HOME || join(home, '.rustup')), '/rustup'],
  ]);
  // rustc uses the last matching prefix, so the most specific paths must come last.
  for (const [path, replacement] of [...mappings].sort((a, b) => a[0].length - b[0].length))
    flags.push(`--remap-path-prefix=${path}=${replacement}`);
  env.CARGO_ENCODED_RUSTFLAGS = flags.join('\x1f');
  delete env.RUSTFLAGS;
  env.CARGO_TARGET_DIR = resolve(
    env.OPENBOT_PORTABLE_CARGO_TARGET_DIR || join(root, '.build/rust-portable'),
  );
  return env;
}

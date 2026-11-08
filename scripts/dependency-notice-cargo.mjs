import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rustEnvironment } from './rust-toolchain.mjs';

async function capture(executable, args, options, label) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) {
      overflow = true;
      child.kill('SIGKILL');
    } else chunks.push(chunk);
  });
  // Cargo diagnostics can contain private cache paths; do not publish or echo them.
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  try {
    await new Promise((yes, no) => {
      child.once('error', () =>
        no(Error(`${label} could not start. Install the configured Rust toolchain.`)),
      );
      child.once('close', (code) =>
        code === 0 && !overflow
          ? yes()
          : no(
              Error(
                `${label} failed. Run cargo fetch --locked for the selected host using the same Cargo cache, then retry the offline notice collection.`,
              ),
            ),
      );
    });
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

export async function readCargoNoticeMetadata(sourceRoot) {
  const env = rustEnvironment();
  const adjacentCargo = join(
    dirname(env.RUSTC),
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
  );
  const executable =
    process.env.OPENBOT_CARGO || (existsSync(adjacentCargo) ? adjacentCargo : 'cargo');
  const options = { cwd: sourceRoot, env };
  const version = await capture(env.RUSTC, ['-vV'], options, 'Rust host detection');
  const host = /^host: ([a-zA-Z0-9_-]+)$/m.exec(version)?.[1];
  if (!host) throw Error('Rust did not report a valid host target for dependency notices.');
  const raw = await capture(
    executable,
    [
      'metadata',
      '--locked',
      '--offline',
      '--format-version',
      '1',
      '--manifest-path',
      join(sourceRoot, 'server/api/Cargo.toml'),
      '--filter-platform',
      host,
    ],
    options,
    'Cargo metadata',
  );
  return { metadata: JSON.parse(raw), host };
}

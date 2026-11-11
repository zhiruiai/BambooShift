import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join, delimiter, resolve } from 'node:path';

// An explicit runtime may be supplied by the owner-only deployment configuration.
function configuredNode() {
  try {
    const path = resolve(process.env.OPENBOT_SERVER_CONFIG || 'config/private/server.private.json');
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384) return;
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) return;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value.nodeBinary === 'string' ? value.nodeBinary : undefined;
  } catch {
    return undefined;
  }
}
const compatible = (version) => {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
};
let executable = process.execPath;
if (!compatible(process.version)) {
  const candidates = [process.env.OPENBOT_NODE, configuredNode()].filter(Boolean);
  executable = candidates.find(
    (path) =>
      existsSync(path) &&
      compatible(spawnSync(path, ['--version'], { encoding: 'utf8' }).stdout.trim()),
  );
  if (!executable) {
    console.error(
      'BambooShift requires Node.js 22.19 or newer. Upgrade Node or set OPENBOT_NODE to an installed runtime.',
    );
    process.exit(1);
  }
}
const env = {
  ...process.env,
  PATH: `${join(executable, '..')}${delimiter}${process.env.PATH ?? ''}`,
};
const envArgs = existsSync('.env') ? ['--env-file=.env'] : [];
const child = spawn(executable, [...envArgs, '--import', 'tsx', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

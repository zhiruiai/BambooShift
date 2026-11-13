import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const fail = (reason) => {
  throw Error(`Client release blocked: ${reason}.`);
};

function inventory(text) {
  const entries = text.split('\n');
  if (entries.at(-1) === '') entries.pop();
  const paths = entries.map((path) => (path.endsWith('/') ? path.slice(0, -1) : path));
  if (
    !entries.length ||
    entries.length > 100_000 ||
    new Set(paths.map((path) => path.normalize('NFC').toLowerCase())).size !== paths.length ||
    paths.some(
      (path) =>
        !path ||
        /[:\\\x00-\x1f\x7f]/.test(path) ||
        path.startsWith('/') ||
        path.split('/').some((part) => !part || /[ .]$/.test(part)),
    )
  )
    fail('invalid or ambiguous ZIP inventory');
  return entries;
}

function candidate(record) {
  if (Array.isArray(record)) return record.some(candidate);
  if (!record || typeof record !== 'object') return false;
  return Object.entries(record).some(
    ([key, value]) =>
      (key === 'releaseApproval' && value !== true) ||
      (key === 'nativeImageCandidate' && value !== false) ||
      (key === 'nativeImage' && value !== undefined) ||
      (value && typeof value === 'object' && candidate(value)),
  );
}

async function readManifest(archive, name) {
  // unzip treats member arguments as patterns; metadata paths must be literal.
  if (/[*?\[\]]/.test(name)) fail('nonliteral metadata path');
  let parsed;
  try {
    const { stdout } = await execute('unzip', ['-p', archive, name], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: 30_000,
    });
    parsed = JSON.parse(stdout);
  } catch {
    fail('unreadable or oversized package metadata');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    fail('invalid package metadata');
  return parsed;
}

/** Inspect actual ZIP members without extracting or executing packaged code. */
export async function checkClientRelease(archive, { platform, arch } = {}) {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
    fail('unsupported client target');
  archive = resolve(archive);
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 ** 3)
    fail('invalid client archive');
  const { stdout } = await execute('unzip', ['-Z1', archive], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  const entries = inventory(stdout);
  const runtimeEntries = entries.filter((name) =>
    name.toLowerCase().split('/').includes('bambooshift-runtime'),
  );
  const sidecars = entries.filter((name) =>
    /(^|\/)manifest-(darwin|win32|linux)-(arm64|x64)\.json$/i.test(name),
  );
  if (sidecars.length > 1) fail('ambiguous client manifest');
  let client;
  if (sidecars.length) {
    client = await readManifest(archive, sidecars[0]);
    if (client.platform !== platform || client.arch !== arch)
      fail('client manifest target differs from its release asset');
    if (candidate(client)) fail('native image candidates are not approved for publication');
    if (typeof client.serviceIncluded !== 'boolean')
      fail('client manifest does not identify its runtime');
  }
  if (!runtimeEntries.length) {
    if (client?.serviceIncluded === true || client?.runtime)
      fail('declared bundled runtime is missing');
    return { bundledRuntime: false };
  }
  if (platform !== 'darwin') fail('this client target has no bundled runtime release schema');
  if (runtimeEntries.some((name) => !name.split('/').includes('bambooshift-runtime')))
    fail('noncanonical bundled runtime directory');
  if (client?.serviceIncluded === false) fail('client manifest hides a bundled runtime');
  // Existing native overlays are explicitly candidate-only. No approved native
  // image release schema exists yet, so a flag change alone cannot release one.
  if (runtimeEntries.some((name) => name.toLowerCase().split('/').includes('native-image-runtime')))
    fail('native image candidates are not approved for publication');
  const manifests = runtimeEntries.filter((name) =>
    name.endsWith('/bambooshift-runtime/desktop-runtime.json'),
  );
  if (manifests.length !== 1) fail('bundled runtime requires one release manifest');
  const root = manifests[0].slice(0, -'desktop-runtime.json'.length);
  if (runtimeEntries.some((name) => name !== root.slice(0, -1) && !name.startsWith(root)))
    fail('ambiguous bundled runtime roots');
  const runtime = await readManifest(archive, manifests[0]);
  if (
    runtime.version !== 1 ||
    runtime.platform !== platform ||
    runtime.architecture !== arch ||
    runtime.server !== 'openbot-backend' ||
    runtime.node !== 'bin/node' ||
    runtime.runtime !== 'runtime'
  )
    fail('bundled runtime identity is invalid');
  if (candidate(runtime)) fail('native image candidates are not approved for publication');
  if (runtime.releaseApproval !== true || (client && client.releaseApproval !== true))
    fail('bundled runtime has no explicit release approval');
  if (
    !entries.includes(root + runtime.server) ||
    !entries.includes(root + runtime.node) ||
    !entries.includes(root + 'runtime/package.json')
  )
    fail('approved bundled runtime is incomplete');
  return { bundledRuntime: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, platform, arch, ...extra] = process.argv.slice(2);
  try {
    if (!archive || extra.length) fail('use <archive> <platform> <arch>');
    const result = await checkClientRelease(archive, { platform, arch });
    console.log(result.bundledRuntime ? 'approved-bundled' : 'connection-client');
  } catch (error) {
    console.error(
      error.message.startsWith('Client release blocked:')
        ? error.message
        : 'Client release blocked: cannot inspect the client archive.',
    );
    process.exitCode = 1;
  }
}

import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
export const macClientIdentifier = 'com.openbot.client';
const fields = ['version', 'kind', 'identity', 'certificateSha256', 'commonName', 'bundleId'];
const invalid = () => Error('本机签名配置无效；请修复原配置，不能以临时签名替代已保存的身份。');

export function macSigningDirectory({ home = homedir() } = {}) {
  return join(home, 'Library/Application Support/BambooShift/build-signing');
}

export function validateMacSigningProfile(profile) {
  if (
    !profile ||
    typeof profile !== 'object' ||
    Array.isArray(profile) ||
    Object.keys(profile).some((key) => !fields.includes(key)) ||
    profile.version !== 1 ||
    profile.kind !== 'local' ||
    !/^[A-F0-9]{40}$/.test(profile.identity ?? '') ||
    !/^[a-f0-9]{64}$/.test(profile.certificateSha256 ?? '') ||
    typeof profile.commonName !== 'string' ||
    !profile.commonName.trim() ||
    profile.commonName.length > 160 ||
    /[\x00-\x1f\x7f]/.test(profile.commonName) ||
    profile.bundleId !== macClientIdentifier
  )
    throw invalid();
  return Object.freeze({ ...profile });
}

export function certificateRequirement(profile, identifier = macClientIdentifier) {
  validateMacSigningProfile(profile);
  if (![macClientIdentifier, 'com.openbot.desktop-helper'].includes(identifier)) throw invalid();
  return `identifier "${identifier}" and certificate leaf = H"${profile.identity}"`;
}

async function inspectIdentity(profile) {
  // Include untrusted local certificates: no system/root trust change is needed
  // for a signature whose identity is pinned to this exact certificate.
  const identities = await execute('/usr/bin/security', ['find-identity', '-p', 'codesigning']);
  if (!new RegExp(`\\b${profile.identity}\\b`, 'i').test(identities.stdout))
    throw Error('已保存的本机签名私钥不可用；请恢复原钥匙串身份，不要重新生成身份或改用临时签名。');
  const certificates = await execute(
    '/usr/bin/security',
    ['find-certificate', '-a', '-c', profile.commonName, '-p'],
    { maxBuffer: 1024 * 1024 },
  );
  const matching = (
    certificates.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  )
    .map((pem) => new X509Certificate(pem))
    .find((cert) => cert.fingerprint.replaceAll(':', '') === profile.identity);
  if (
    !matching ||
    matching.fingerprint256.replaceAll(':', '').toLowerCase() !== profile.certificateSha256 ||
    !matching.keyUsage?.includes('1.3.6.1.5.5.7.3.3') ||
    Date.parse(matching.validFrom) > Date.now() ||
    Date.parse(matching.validTo) <= Date.now()
  )
    throw Error('本机签名证书不匹配、不可用于代码签名或已过期；请恢复原签名配置。');
}

async function inspectExistingIdentity() {
  if (process.platform !== 'darwin') return false;
  const identities = await execute('/usr/bin/security', ['find-identity', '-p', 'codesigning']);
  return /"BambooShift Local [^"\r\n]+"/.test(identities.stdout);
}

async function optionalDirectory(path) {
  try {
    return await lstat(dirname(path));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw invalid();
  }
}

function privateEntry(stat, directory) {
  return (
    (directory ? stat.isDirectory() : stat.isFile()) &&
    (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid())
  );
}

export async function resolveMacSigningProfile({
  sourceRoot = root,
  signingDirectory = macSigningDirectory(),
  environment = process.env,
  profilePath = environment.BAMBOOSHIFT_MAC_SIGNING_PROFILE,
  inspect = inspectIdentity,
  inspectExisting = inspectExistingIdentity,
} = {}) {
  const explicit = profilePath !== undefined;
  if (explicit && (!profilePath || /[\x00-\x1f\x7f]/.test(profilePath))) throw invalid();
  let path = explicit ? resolve(profilePath) : join(signingDirectory, 'identity.json');
  let parent = await optionalDirectory(path);
  if (!parent) {
    if (explicit) throw invalid();
    // A fresh checkout must reuse the user's canonical identity. A legacy local
    // profile is readable only before that canonical directory has been created.
    path = join(sourceRoot, '.local/macos-signing/identity.json');
    parent = await optionalDirectory(path);
    if (!parent) {
      if (await inspectExisting())
        throw Error('钥匙串中已有 BambooShift 本机签名身份；请恢复原签名配置，不能改用临时签名。');
      return undefined;
    }
  }
  // A configured directory with a missing profile is an interrupted or broken
  // identity, not permission to silently fall back to ad-hoc signing.
  if (!privateEntry(parent, true)) throw invalid();
  const file = await lstat(path).catch(() => {
    throw invalid();
  });
  if (!privateEntry(file, false) || file.size > 4096) throw invalid();
  let profile;
  try {
    profile = validateMacSigningProfile(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw invalid();
  }
  await inspect(profile);
  return profile;
}

export async function readCodeRequirements(bundle) {
  const result = await execute('/usr/bin/codesign', ['--display', '-r-', bundle]);
  return result.stdout + result.stderr;
}

export async function verifyStableMacSignature(
  bundle,
  profile,
  { command, identifier = macClientIdentifier, readRequirements = readCodeRequirements } = {},
) {
  const expected = certificateRequirement(profile, identifier);
  await command('/usr/bin/codesign', ['--verify', '--strict', '-R', '=' + expected, bundle]);
  const text = await readRequirements(bundle);
  const designated = text.split('\n').find((line) => line.startsWith('designated => '));
  // Check the embedded DR, not merely that today's bytes satisfy an external
  // requirement. Updates must retain the same signer-and-identifier boundary.
  const normalized = designated
    ?.slice('designated => '.length)
    .replace(/H"([a-fA-F0-9]+)"/g, (_match, hash) => `H"${hash.toUpperCase()}"`);
  if (normalized !== expected)
    throw Error('签名身份不稳定：应用必须保存证书绑定的指定要求，不能依赖版本哈希或仅应用标识。');
}

import { execFile } from 'node:child_process';
import { X509Certificate, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  certificateRequirement,
  macSigningDirectory,
  validateMacSigningProfile,
  verifyStableMacSignature,
} from './macos-signing-profile.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundleId = 'com.openbot.client';
const run = async (program, args, options = {}) =>
  execute(program, args, {
    cwd: root,
    maxBuffer: 1024 * 1024,
    ...options,
  });

async function privateDirectory(path, ownerOnly = true) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    stat.mode & (ownerOnly ? 0o077 : 0o022)
  )
    throw Error('The local signing directory must be owned by this user and have mode 0700.');
}

async function readPrivate(path) {
  const stat = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 4096)
    throw Error('The local signing profile must be an owner-only regular file.');
  return validateMacSigningProfile(JSON.parse(await readFile(path, 'utf8')));
}

async function verifyIdentity(profile, directory, command = run) {
  validateMacSigningProfile(profile);
  const { stdout: certificates } = await command('/usr/bin/security', [
    'find-certificate',
    '-a',
    '-p',
    '-c',
    profile.commonName,
  ]);
  const found = (
    certificates.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []
  )
    .map((pem) => new X509Certificate(pem))
    .find((cert) => cert.fingerprint.replaceAll(':', '') === profile.identity);
  if (
    !found ||
    found.fingerprint256.replaceAll(':', '').toLowerCase() !== profile.certificateSha256 ||
    !found.keyUsage?.includes('1.3.6.1.5.5.7.3.3') ||
    Date.parse(found.validFrom) > Date.now() ||
    Date.parse(found.validTo) <= Date.now()
  )
    throw Error('The saved signing certificate is missing or changed; it will not be regenerated.');
  const { stdout: identities } = await command('/usr/bin/security', [
    'find-identity',
    '-p',
    'codesigning',
  ]);
  if (!identities.includes(profile.identity))
    throw Error('The saved certificate has no available private signing identity.');
  const probe = await mkdtemp(join(directory, '.verify-'));
  try {
    const requirement = certificateRequirement(profile);
    const reports = [];
    for (const version of ['a', 'b']) {
      const source = join(probe, `${version}.c`),
        executable = join(probe, version);
      await writeFile(
        source,
        `#include <stdio.h>\nint main(void) { puts("BambooShift signing ${version}"); return 0; }\n`,
        { mode: 0o600 },
      );
      await command('/usr/bin/xcrun', ['clang', source, '-o', executable]);
      await command('/usr/bin/codesign', [
        '--force',
        '--sign',
        profile.identity,
        '--identifier',
        bundleId,
        '--options',
        'runtime',
        '--timestamp=none',
        '--requirements',
        '=designated => ' + requirement,
        executable,
      ]);
      await verifyStableMacSignature(executable, profile, {
        command,
        readRequirements: async (path) => {
          const result = await command('/usr/bin/codesign', ['--display', '-r-', path]);
          return result.stdout + result.stderr;
        },
      });
      const report = await command('/usr/bin/codesign', [
        '--display',
        '--verbose=4',
        '-r',
        '-',
        executable,
      ]);
      reports.push(report.stderr + report.stdout);
    }
    const hashes = reports.map((report) => report.match(/^CDHash=([a-f0-9]+)$/m)?.[1]);
    if (
      !hashes.every(Boolean) ||
      hashes[0] === hashes[1] ||
      reports.some(
        (report) =>
          !report.includes(`certificate leaf = H"${profile.identity.toLowerCase()}"`) &&
          !report.includes(`certificate leaf = H"${profile.identity}"`),
      )
    )
      throw Error('Two different builds did not establish the same certificate-bound identity.');
    const other = join(probe, 'other');
    await copyFile(join(probe, 'a'), other);
    await command('/usr/bin/codesign', ['--remove-signature', other]);
    await command('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', bundleId, other]);
    let rejected = false;
    try {
      await command('/usr/bin/codesign', ['--verify', '--strict', '-R', '=' + requirement, other]);
    } catch {
      rejected = true;
    }
    if (!rejected) throw Error('An unrelated signer unexpectedly satisfied the saved identity.');
    return { buildsDiffer: true, requirementsMatch: true, unrelatedSignerRejected: true };
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

async function prepareIdentity(temporary, command) {
  const commonName = `BambooShift Local ${randomUUID()}`;
  const config = join(temporary, 'certificate.cnf');
  const key = join(temporary, 'identity-key.pem'),
    certificate = join(temporary, 'identity.pem');
  const archive = join(temporary, `${commonName}.pem`);
  await writeFile(
    config,
    `[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=extensions\n[subject]\nCN=${commonName}\nO=BambooShift Local Development\n[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n`,
    { mode: 0o600 },
  );
  await command('/usr/bin/openssl', [
    'req',
    '-new',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-sha256',
    '-days',
    '3650',
    '-config',
    config,
    '-keyout',
    key,
    '-out',
    certificate,
  ]);
  const cert = new X509Certificate(await readFile(certificate));
  const profile = {
    version: 1,
    kind: 'local',
    identity: cert.fingerprint.replaceAll(':', ''),
    certificateSha256: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
    commonName,
    bundleId,
  };
  const { stdout } = await command('/usr/bin/security', ['default-keychain', '-d', 'user']);
  const keychain = stdout.trim().replace(/^"|"$/g, '');
  if (!keychain) throw Error('No user keychain is available for the persistent signing identity.');
  // Import an owner-only temporary PEM directly: this preserves the -x key
  // attributes and needs no archive passphrase in process arguments or logs.
  await writeFile(
    archive,
    Buffer.concat([await readFile(key), Buffer.from('\n'), await readFile(certificate)]),
    { mode: 0o600, flag: 'wx' },
  );
  return {
    profile,
    importIdentity: () =>
      command('/usr/bin/security', [
        'import',
        archive,
        '-k',
        keychain,
        '-f',
        'pemseq',
        '-t',
        'agg',
        '-x',
        '-T',
        '/usr/bin/codesign',
      ]),
  };
}

async function legacyProfile(sourceRoot) {
  const directory = resolve(sourceRoot, '.local/macos-signing');
  const stat = await lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat === undefined) return undefined;
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw Error('The legacy signing directory must be an owner-only ordinary directory.');
  const existing = await readPrivate(join(directory, 'identity.json'));
  const pending = await readPrivate(join(directory, 'pending.json'));
  if (existing !== undefined && pending !== undefined && existing.identity !== pending.identity)
    throw Error(
      'Conflicting legacy signing identities require recovery; neither will be replaced.',
    );
  if (existing === undefined && pending === undefined)
    throw Error(
      'The legacy signing directory has no profile; restore it before creating an identity.',
    );
  return existing ?? pending;
}

async function inspectExistingIdentity(command) {
  const { stdout } = await command('/usr/bin/security', ['find-identity', '-p', 'codesigning']);
  return /"BambooShift Local [^"]+"/.test(stdout);
}

async function acquireLock(directory) {
  const path = join(directory, '.provision.lock');
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error(
        `Another signing setup owns ${path}. Wait for it to finish; after a terminated process, remove only this lock directory before retrying. Saved identity metadata must be retained.`,
      );
    throw error;
  }
  try {
    await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return () => rm(path, { recursive: true, force: true });
}

async function savePending(path, profile) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(profile, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function createMacSigningIdentity({
  sourceRoot = root,
  home,
  command = run,
  prepare = prepareIdentity,
  verify = verifyIdentity,
  inspectExisting = inspectExistingIdentity,
} = {}) {
  if (process.platform !== 'darwin') throw Error('Local Mac signing requires macOS.');
  const directory = macSigningDirectory({ home });
  await privateDirectory(directory);
  const release = await acquireLock(directory);
  try {
    const profilePath = join(directory, 'identity.json');
    const pendingPath = join(directory, 'pending.json');
    const existing = await readPrivate(profilePath);
    let profile = await readPrivate(pendingPath);
    if (existing !== undefined) {
      if (profile !== undefined && existing.identity !== profile.identity)
        throw Error(
          'Conflicting saved signing identities require recovery; neither will be replaced.',
        );
      const verification = await verify(existing, directory, command);
      if (profile !== undefined) await rm(pendingPath);
      return { created: false, profilePath, identity: existing.identity, verification };
    }
    let migrated = false;
    let verification;
    if (profile === undefined) {
      profile = await legacyProfile(sourceRoot);
      migrated = profile !== undefined;
      if (profile !== undefined) {
        // Leave legacy metadata intact. Verify before publishing its canonical copy.
        verification = await verify(profile, directory, command);
        await savePending(pendingPath, profile);
      } else {
        if (await inspectExisting(command))
          throw Error(
            'A BambooShift signing identity already exists in the keychain. Restore its public profile instead of generating a replacement.',
          );
        const temporary = await mkdtemp(join(directory, '.create-'));
        try {
          const prepared = await prepare(temporary, command);
          profile = validateMacSigningProfile(prepared.profile);
          // This public journal must exist before the first keychain mutation.
          // Interrupted/partial imports retry this exact fingerprint and fail closed
          // if its key is unavailable; they never generate a replacement identity.
          await savePending(pendingPath, profile);
          await prepared.importIdentity();
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
    }
    verification ??= await verify(profile, directory, command);
    await rename(pendingPath, profilePath);
    return { created: !migrated, migrated, profilePath, identity: profile.identity, verification };
  } finally {
    await release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2)
    throw Error('Usage: node scripts/desktop/create-macos-signing-identity.mjs');
  process.umask(0o077);
  try {
    console.log(JSON.stringify(await createMacSigningIdentity(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

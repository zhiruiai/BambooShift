import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nodeArtifact(version, platform, arch) {
  if (
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !['darwin', 'linux'].includes(platform) ||
    !['arm64', 'x64'].includes(arch)
  )
    throw Error('Unsupported Node runtime target.');
  return `node-v${version}-${platform}-${arch}`;
}

export function verifyNodeArchive(bytes, sums, filename) {
  const expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === filename)?.[0];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || actual !== expected)
    throw Error('The official Node archive checksum did not match.');
  return actual;
}

export async function download(url, limit, redirect = 'error') {
  const response = await fetch(url, { redirect, signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw Error('The official Node runtime download failed.');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error('The Node runtime download exceeded its size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

/** Use an official relocatable distribution, not a potentially Homebrew-linked host binary. */
export async function stageNodeRuntime({
  output,
  version,
  platform,
  arch,
  command,
  fetchBytes = download,
}) {
  const stem = nodeArtifact(version, platform, arch);
  const filename = `${stem}.tar.gz`,
    origin = `https://nodejs.org/dist/v${version}/`;
  const sums = (await fetchBytes(origin + 'SHASUMS256.txt', 256 * 1024)).toString('utf8');
  const bytes = await fetchBytes(origin + filename, 160 * 1024 * 1024);
  const archiveSha256 = verifyNodeArchive(bytes, sums, filename);
  const temporary = await mkdtemp(join(dirname(output), '.node-runtime-'));
  try {
    const archive = join(temporary, filename);
    await writeFile(archive, bytes);
    await command(
      'tar',
      ['-xzf', archive, '-C', temporary, `${stem}/bin/node`, `${stem}/LICENSE`],
      temporary,
    );
    const binary = join(temporary, stem, 'bin/node');
    const license = join(temporary, stem, 'LICENSE');
    for (const file of [binary, license]) {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Invalid Node distribution entry.');
    }
    await mkdir(join(output, 'bin'));
    await copyFile(binary, join(output, 'bin/node'));
    await chmod(join(output, 'bin/node'), 0o755);
    await copyFile(license, join(output, 'bin/LICENSE'));
    return {
      nodeVersion: version,
      preSignNodeSha256: createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
      nodeArchiveSha256: archiveSha256,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

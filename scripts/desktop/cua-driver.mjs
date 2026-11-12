import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { download } from './node-runtime.mjs';
import { verifiedArchive } from './archive-cache.mjs';

export const cuaDriverArtifact = Object.freeze({
  version: '0.47.8',
  filename: 'cua-driver-rs-0.47.8-darwin-universal-binary.tar.gz',
  sha256: '2189794e02a142f79980ad5b9080270c66651daa986acfb9fc0d93396602e377',
  licenseSha256: 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9',
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Ship the MIT standalone executable only, without optional SDK or N-API artifacts. */
export async function stageCuaDriver({
  output,
  platform,
  sourceRoot,
  command,
  fetchBytes = download,
}) {
  if (platform !== 'darwin') return { hostControl: false };
  const artifact = cuaDriverArtifact;
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${artifact.version}/${artifact.filename}`;
  const bytes = await verifiedArchive({
    directory: join(sourceRoot, '.build/vendor/cua-driver'),
    name: artifact.filename,
    sha256: artifact.sha256,
    maxBytes: 80 * 1024 * 1024,
    download: () => fetchBytes(url, 80 * 1024 * 1024, 'follow'),
  });
  const license = join(sourceRoot, `legal/third-party/cua-driver-${artifact.version}/LICENSE.md`);
  if (digest(await readFile(license)) !== artifact.licenseSha256)
    throw Error('The Cua Driver license checksum did not match.');
  const temporary = await mkdtemp(join(dirname(output), '.cua-driver-'));
  try {
    const archive = join(temporary, artifact.filename);
    await writeFile(archive, bytes);
    await command('tar', ['-xzf', archive, '-C', temporary, 'cua-driver'], temporary);
    const executable = join(temporary, 'cua-driver');
    const stat = await lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1024 * 1024)
      throw Error('Invalid Cua Driver executable.');
    await mkdir(join(output, 'bin'), { recursive: true });
    await mkdir(join(output, 'licenses'), { recursive: true });
    await copyFile(executable, join(output, 'bin/cua-driver'));
    await chmod(join(output, 'bin/cua-driver'), 0o755);
    await copyFile(license, join(output, 'licenses/CuaDriver-LICENSE.md'));
    await command(join(output, 'bin/cua-driver'), ['--version'], output);
    return {
      hostControl: true,
      desktopDriver: 'cua',
      desktopDriverVersion: artifact.version,
      desktopDriverArchiveSha256: artifact.sha256,
      preSignDesktopDriverSha256: digest(await readFile(executable)),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

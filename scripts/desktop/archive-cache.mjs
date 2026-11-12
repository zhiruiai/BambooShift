import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Cache only public upstream archives; every read is bound to a reviewed digest. */
export async function verifiedArchive({ directory, name, sha256, maxBytes, download }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(sha256))
    throw Error('Invalid public archive identity.');
  const verify = (bytes) => {
    if (bytes.length > maxBytes || createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw Error('The public archive checksum did not match.');
    return bytes;
  };
  const archive = join(directory, name);
  try {
    const parent = await lstat(directory);
    if (!parent.isDirectory()) throw Error('Invalid archive cache directory.');
    const file = await lstat(archive);
    if (!file.isFile() || file.size > maxBytes) throw Error('Invalid cached archive.');
    return verify(await readFile(archive));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const bytes = verify(await download());
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) throw Error('Invalid archive cache directory.');
  const temporary = join(directory, `.${name}-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, archive);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes;
}

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export function desktopProductName(manifest) {
  const { productName } = manifest;
  if (typeof productName !== 'string' || !/^[A-Z][A-Za-z0-9]{0,39}$/.test(productName))
    throw new Error('desktop/package.json must declare a valid product name.');
  return productName;
}

export async function readDesktopProductName(root) {
  const directory = join(root, 'desktop');
  const manifestPath = join(directory, 'package.json');
  if (!(await lstat(directory)).isDirectory() || !(await lstat(manifestPath)).isFile())
    throw new Error('desktop/package.json must be a regular file in the source tree.');
  const file = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536)
      throw new Error('desktop/package.json is not a bounded regular file.');
    return desktopProductName(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}

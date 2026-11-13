import { cp, lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function inside(root, path) {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Keep npm's relative links relocatable without importing files outside the runtime. */
export async function copyDesktopRuntime(source, destination) {
  const sourcePath = resolve(source);
  if (!(await lstat(sourcePath)).isDirectory())
    throw Error('Desktop runtime source must be a real directory.');
  const root = await realpath(sourcePath);
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !inside(root, resolve(dirname(path), target)))
          throw Error('Desktop runtime symlinks must be relative and stay inside the runtime.');
        let resolved;
        try {
          resolved = await realpath(path);
        } catch {
          throw Error('Desktop runtime contains a broken or cyclic symlink.');
        }
        if (!inside(root, resolved))
          throw Error('Desktop runtime symlinks must resolve inside the runtime.');
      }
    }
  }
  await cp(root, destination, {
    recursive: true,
    verbatimSymlinks: true,
    dereference: false,
    force: false,
    errorOnExist: true,
  });
}

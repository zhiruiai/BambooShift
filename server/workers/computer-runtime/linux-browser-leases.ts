import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ComputerScreenConfiguration } from '../../../shared/computer-screens.js';
import { sameDesktopSession } from '../../../shared/linux-desktop.js';

const invalid = () =>
  Object.assign(new Error('浏览器清理记录不可用，画面需要维护。'), { cleanupConfirmed: false });

/** The lease is durable before spawn so restart never guesses that a browser exited. */
export function browserLeaseJournal(directory: string, scope: string) {
  async function location(screen: ComputerScreenConfiguration, revision: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw invalid();
    const name = createHash('sha256')
      .update(JSON.stringify([scope, screen.id, revision, screen.session]))
      .digest('hex');
    return join(directory, `${name}.json`);
  }
  return {
    async read(screen: ComputerScreenConfiguration, revision: string): Promise<string | undefined> {
      const path = await location(screen, revision);
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error: any) {
        if (error.code === 'ENOENT') return;
        throw invalid();
      }
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.mode & 0o077 ||
          stat.size > 4096 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw invalid();
        const value = JSON.parse(await file.readFile('utf8'));
        if (
          value.scope !== scope ||
          value.screen !== screen.id ||
          value.revision !== revision ||
          !sameDesktopSession(value.session, screen.session) ||
          typeof value.lease !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.lease)
        )
          throw invalid();
        return value.lease;
      } catch {
        throw invalid();
      } finally {
        await file.close();
      }
    },
    async write(screen: ComputerScreenConfiguration, revision: string, lease: string) {
      const path = await location(screen, revision);
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(
          JSON.stringify({ scope, screen: screen.id, revision, session: screen.session, lease }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      const parent = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    },
    async clear(screen: ComputerScreenConfiguration, revision: string) {
      await unlink(await location(screen, revision));
    },
  };
}

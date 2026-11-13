import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Real, synthetic ZIPs exercise the publisher's archive reader without binaries. */
export async function writeClientArchive(archive, entries) {
  const directory = await mkdtemp(join(dirname(archive), '.zip-fixture-'));
  try {
    for (const [name, content] of Object.entries(entries)) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    await rm(archive, { force: true });
    execFileSync(
      'zip',
      ['-q', '-r', archive, ...new Set(Object.keys(entries).map((name) => name.split('/')[0]))],
      { cwd: directory, timeout: 10_000 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

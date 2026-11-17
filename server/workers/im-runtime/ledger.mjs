import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export function openLedger(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    (process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077))
  )
    throw Error('IM state directory must be owner-only');
  const path = join(directory, 'channel-events.sqlite');
  try {
    if (!lstatSync(path).isFile()) throw Error('IM state must be a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const db = new DatabaseSync(path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  db.exec(
    'CREATE TABLE IF NOT EXISTS deliveries (key TEXT PRIMARY KEY, status TEXT NOT NULL, created INTEGER NOT NULL)',
  );
  return {
    claim(key) {
      // Retain pending/unknown keys; fresh delivery after a crash requires explicit operator review.
      if (db.prepare('SELECT 1 FROM deliveries WHERE key=?').get(key)) return false;
      if (db.prepare('SELECT count(*) AS count FROM deliveries').get().count >= 100000)
        throw Error('Channel event ledger needs maintenance');
      return (
        db.prepare("INSERT OR IGNORE INTO deliveries VALUES (?, 'pending', ?)").run(key, Date.now())
          .changes === 1
      );
    },
    finish: (key, status) =>
      db.prepare('UPDATE deliveries SET status=? WHERE key=?').run(status, key),
    close: () => db.close(),
  };
}

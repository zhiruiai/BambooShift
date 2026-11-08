import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { IDENTITY_SCHEMA, TEMPLATE_SCHEMA } from './schema.fixture.js';

// This writer creates only new, synthetic compatibility fixtures. It is not a business store.
function database(path: string, schema: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(schema);
  chmodSync(path, 0o600);
  return db;
}

export function legacyIdentityFixture(path: string) {
  const db = database(path, IDENTITY_SCHEMA);
  const clock = Date.now();
  const password = 'synthetic-password-42';
  const salt = randomBytes(24).toString('hex');
  const hash =
    'scrypt-v1:' +
    salt +
    ':' +
    scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString(
      'hex',
    );
  const person = { user: { id: randomUUID() }, workspaceId: randomUUID() };
  const owner = { user: { id: randomUUID() }, workspaceId: randomUUID() };
  for (const [entry, name, email] of [
    [person, 'Fixture person', 'person@example.test'],
    [owner, 'Fixture owner', 'team@example.test'],
  ] as const)
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(
      entry.user.id,
      email,
      name,
      hash,
      'active',
      'user',
      clock,
    );
  const team = { user: owner.user, workspaceId: randomUUID() };
  const legacy = randomUUID();
  for (const [entry, kind, name] of [
    [person, 'personal', 'Synthetic personal'],
    [owner, 'personal', 'Synthetic owner personal'],
    [team, 'team', 'Synthetic team'],
  ] as const) {
    db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?)').run(
      entry.workspaceId,
      name,
      kind,
      'active',
      entry.workspaceId,
      clock,
    );
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(
      entry.workspaceId,
      entry.user.id,
      'owner',
      clock,
    );
  }
  db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?)').run(
    legacy,
    'Synthetic legacy space',
    'personal',
    'active',
    'legacy',
    clock,
  );
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(legacy, person.user.id, 'owner', clock);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(
    team.workspaceId,
    person.user.id,
    'member',
    clock,
  );
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?,?)').run(
    randomUUID(),
    createHash('sha256').update(token).digest('hex'),
    person.user.id,
    'account',
    'Synthetic original Node browser',
    clock,
    clock + 30 * 86400000,
  );
  return { platform: { db, close: () => db.close() }, person, team, legacy, token };
}

const tables = new Set([
  'agents',
  'conversations',
  'messages',
  'memories',
  'routines',
  'skills',
  'files',
  'settings',
]);
export function legacyRecordsFixture(path: string) {
  const db = database(
    path,
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;' +
      [...tables]
        .map((table) => `CREATE TABLE ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL);`)
        .join(''),
  );
  return {
    db,
    put(table: string, value: { id: string; [key: string]: unknown }) {
      if (!tables.has(table)) throw Error('Unknown legacy fixture table');
      db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run(value.id, JSON.stringify(value));
    },
    list(table: string): Record<string, any>[] {
      if (!tables.has(table)) throw Error('Unknown legacy fixture table');
      return db
        .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => JSON.parse(String(row.data)));
    },
    close() {
      db.close();
    },
  };
}

export function legacyTemplatesFixture(path: string) {
  const db = database(path, TEMPLATE_SCHEMA);
  return {
    db,
    save(value: { id: string; workspaceId: string; [key: string]: unknown }) {
      db.prepare('INSERT INTO templates VALUES(?,?,?,NULL)').run(
        value.id,
        value.workspaceId,
        JSON.stringify(value),
      );
    },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const legacyDigest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

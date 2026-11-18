// Frozen legacy SQLite contracts from the retired Node backend. Synthetic migration tests only.
export const IDENTITY_SCHEMA = `
PRAGMA journal_mode=WAL;
 PRAGMA foreign_keys=ON;
 PRAGMA busy_timeout=5000;

      CREATE TABLE IF NOT EXISTS platform_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','suspended')),platform_role TEXT NOT NULL CHECK(platform_role IN ('user','admin')),created_at INTEGER NOT NULL);

      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('personal','team')),status TEXT NOT NULL CHECK(status IN ('active','suspended')),storage_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);

      CREATE TABLE IF NOT EXISTS memberships (workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('owner','member')),joined_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,user_id));

      CREATE UNIQUE INDEX IF NOT EXISTS one_workspace_owner ON memberships(workspace_id) WHERE role='owner';

      CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id),purpose TEXT NOT NULL CHECK(purpose IN ('account','operator')),name TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);

      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL REFERENCES workspaces(id),created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER,used_by TEXT REFERENCES users(id),revoked_at INTEGER);

      CREATE TABLE IF NOT EXISTS account_attempts (bucket TEXT PRIMARY KEY,started_at INTEGER NOT NULL,attempts INTEGER NOT NULL);
`;
export const TEMPLATE_SCHEMA = `
PRAGMA journal_mode=WAL;
 PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sharing_policies(workspace_id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,data TEXT NOT NULL,avatar BLOB);
CREATE INDEX IF NOT EXISTS templates_workspace ON templates(workspace_id);
CREATE TABLE IF NOT EXISTS template_versions(id TEXT PRIMARY KEY,template_id TEXT NOT NULL,workspace_id TEXT NOT NULL,data TEXT NOT NULL,avatar BLOB);
CREATE TABLE IF NOT EXISTS template_links(token TEXT PRIMARY KEY,template_id TEXT NOT NULL,version_id TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS template_links_template ON template_links(template_id);
CREATE TABLE IF NOT EXISTS template_mutations(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,workspace_id TEXT NOT NULL,digest TEXT NOT NULL,template_id TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));
`;

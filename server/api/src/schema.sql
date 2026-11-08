CREATE TABLE IF NOT EXISTS platform_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','suspended')),platform_role TEXT NOT NULL CHECK(platform_role IN ('user','admin')),created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('personal','team')),status TEXT NOT NULL CHECK(status IN ('active','suspended')),storage_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('owner','member')),joined_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,user_id));
CREATE UNIQUE INDEX IF NOT EXISTS one_workspace_owner ON memberships(workspace_id) WHERE role='owner';
CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id),purpose TEXT NOT NULL CHECK(purpose IN ('account','operator')),name TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL REFERENCES workspaces(id),created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER,used_by TEXT REFERENCES users(id),revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS account_attempts (bucket TEXT PRIMARY KEY,started_at INTEGER NOT NULL,attempts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS website_project_shares (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_key TEXT NOT NULL,
    publisher_id TEXT REFERENCES users(id),
    revision TEXT NOT NULL,
    token TEXT UNIQUE,
    visibility TEXT NOT NULL CHECK(visibility IN ('private','invited','team','public')),
    version_id TEXT,
    viewer_ids TEXT NOT NULL,
    PRIMARY KEY(workspace_id,project_key)
);
CREATE TABLE IF NOT EXISTS routine_webhook_keys (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    routine_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL REFERENCES users(id),
    revision TEXT NOT NULL,
    key_digest TEXT,
    target_generation TEXT NOT NULL,
    PRIMARY KEY(workspace_id,routine_id)
);
CREATE TABLE IF NOT EXISTS account_workspace_avatar_themes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    theme_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    PRIMARY KEY(user_id, workspace_id)
);

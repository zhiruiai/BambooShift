import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import {
  legacyIdentityFixture,
  legacyRecordsFixture,
  legacyTemplatesFixture,
  legacyDigest as digest,
} from './migration-fixture/stores.fixture.js';
import type { BotBlueprint } from '../shared/bot-blueprint.js';

const directory = resolve(process.argv[2] || '');
if (!process.argv[2]) throw Error('An explicit new synthetic fixture directory is required.');
mkdirSync(directory, { mode: 0o700 });
const { platform, person, team, token } = legacyIdentityFixture(
  join(directory, 'platform/identity.sqlite'),
);
const timestamp = '2026-01-01T00:00:00.000Z';
const avatarBytes = await sharp({
  create: { width: 512, height: 512, channels: 4, background: '#8b5cf6' },
})
  .webp()
  .toBuffer();
const workspaces = platform.db
  .prepare('SELECT id,storage_key,kind FROM workspaces ORDER BY rowid')
  .all();
const identities: Array<{ id: string; agent: string; chat: string; avatar: string }> = [];
for (const row of workspaces) {
  const workspaceId = String(row.id);
  const root = row.storage_key === 'legacy' ? directory : join(directory, 'spaces', workspaceId);
  const store = legacyRecordsFixture(join(root, 'openbot.sqlite'));
  const agent = randomUUID(),
    chat = randomUUID(),
    avatar = randomUUID(),
    profile = randomUUID();
  const bot = {
    id: agent,
    name: 'Original fixture Bot',
    role: 'Research',
    description: 'Synthetic saved profile',
    instructions: 'Keep this exact instruction 🐷',
    color: '#8b5cf6',
    avatar: 'leaf' as const,
    avatarImageId: avatar,
    status: 'working' as const,
    configRevision: randomUUID(),
  };
  store.put('agents', bot);
  store.put('conversations', {
    id: chat,
    title: 'Original fixture chat',
    agentIds: [agent],
    isGroup: false,
    updatedAt: timestamp,
    unread: 1,
    pinned: false,
  });
  for (const value of [
    {
      id: 'completed',
      role: 'assistant' as const,
      status: 'done' as const,
      content: 'Previously completed answer 🐷',
      agentId: agent,
    },
    {
      id: 'queued',
      role: 'user' as const,
      status: 'done' as const,
      content: 'Original queued input',
      delivery: { state: 'queued' as const, mode: 'followUp' as const, clientId: randomUUID() },
    },
    {
      id: 'started',
      role: 'user' as const,
      status: 'done' as const,
      content: 'Original running input',
      delivery: { state: 'delivered' as const, mode: 'followUp' as const, clientId: randomUUID() },
    },
    {
      id: 'unfinished',
      role: 'assistant' as const,
      status: 'running' as const,
      content: 'Actual partial output',
      agentId: agent,
      metadata: { inputMessageId: 'started' },
    },
  ])
    store.put('messages', { ...value, conversationId: chat, createdAt: timestamp, kind: 'text' });
  store.put('memories', {
    id: randomUUID(),
    agentId: agent,
    content: 'Existing preference remains exact.',
    category: 'preference',
    createdAt: timestamp,
  });
  store.put('routines', {
    id: randomUUID(),
    title: 'Existing overdue schedule',
    prompt: 'Never run during offline rehearsal.',
    agentId: agent,
    conversationId: chat,
    schedule: 'weekly:1,3,5:09:00',
    timeZone: 'America/New_York',
    enabled: true,
    nextRunAt: timestamp,
  });
  store.put('skills', {
    id: randomUUID(),
    agentId: agent,
    name: 'Synthetic procedure',
    description: 'Keep the existing version',
    content: 'Read the approved report.',
    status: 'active',
    version: 3,
    createdAt: timestamp,
  });
  mkdirSync(join(root, 'workspace'), { recursive: true, mode: 0o700 });
  const file = Buffer.from('Registered synthetic report 🐷\n');
  writeFileSync(join(root, 'workspace/report.md'), file, { mode: 0o600 });
  store.put('files', {
    id: randomUUID(),
    name: 'report.md',
    size: file.length,
    type: 'text/markdown',
    createdAt: timestamp,
    conversationId: chat,
  });
  store.put('settings', { id: 'seeded', value: true });
  store.put('settings', {
    id: 'model',
    profileId: profile,
    provider: 'synthetic',
    model: 'offline',
    baseUrl: 'https://never-called.example.test/v1',
  });
  store.put('settings', {
    id: `model-profile:${profile}`,
    name: 'Original model',
    provider: 'synthetic',
    model: 'offline',
    baseUrl: 'https://never-called.example.test/v1',
  });
  store.put('settings', {
    id: `model-profile-secret:${profile}`,
    provider: 'synthetic',
    baseUrl: 'https://never-called.example.test/v1',
    apiKey: 'SYNTHETIC_LEGACY_MODEL_KEY',
  });
  store.db.exec(
    'CREATE TABLE avatar_assets(id TEXT PRIMARY KEY,data TEXT NOT NULL,bytes BLOB NOT NULL,published INTEGER NOT NULL DEFAULT 0); CREATE TABLE app_connections(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE app_actions(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE routine_runs(run_id TEXT PRIMARY KEY,routine_id TEXT NOT NULL,started_at TEXT NOT NULL,data TEXT NOT NULL)',
  );
  store.db.prepare('INSERT INTO avatar_assets VALUES(?,?,?,1)').run(
    avatar,
    JSON.stringify({
      id: avatar,
      width: 512,
      height: 512,
      mimeType: 'image/webp',
      createdAt: timestamp,
    }),
    avatarBytes,
  );
  const app = randomUUID();
  store.db.prepare('INSERT INTO app_connections VALUES(?,?)').run(
    app,
    JSON.stringify({
      id: app,
      name: 'Original application',
      url: 'https://never-called.example.test/mcp',
      authType: 'bearer',
      token: 'SYNTHETIC_LEGACY_APP_KEY',
      credentialGeneration: randomUUID(),
      revision: randomUUID(),
      shared: true,
      status: 'connected',
      tools: [
        {
          name: 'read_report',
          description: 'Read the fixture',
          inputSchema: {
            type: 'object',
            properties: { z: { type: 'string' }, a: { type: 'string' } },
          },
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  const operation = randomUUID();
  store.db.prepare('INSERT INTO app_actions VALUES(?,?)').run(
    operation,
    JSON.stringify({
      id: operation,
      action: { id: operation, connectionId: app, status: 'running' },
      conversationId: chat,
      agentId: agent,
    }),
  );
  const routine = store.list('routines')[0];
  const run = randomUUID();
  store.db.prepare('INSERT INTO routine_runs VALUES(?,?,?,?)').run(
    run,
    routine.id,
    timestamp,
    JSON.stringify({
      runId: run,
      routineId: routine.id,
      agentId: agent,
      conversationId: chat,
      startedAt: timestamp,
      status: 'running',
      trigger: 'scheduled',
    }),
  );
  mkdirSync(join(root, 'pi'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, 'pi/fixture.jsonl'),
    JSON.stringify({ content: 'Preserved original Pi history.' }) + '\n',
    { mode: 0o600 },
  );
  identities.push({ id: workspaceId, agent, chat, avatar });
  store.close();
}
const source = identities.find((w) => w.id === team.workspaceId)!;
const repository = legacyTemplatesFixture(join(directory, 'platform/bot-templates.sqlite'));
const template = randomUUID(),
  version = randomUUID();
const blueprint: BotBlueprint = {
  version: 1,
  profile: {
    name: 'Published fixture',
    role: 'Review',
    description: 'Original published template',
    instructions: 'Keep this published instruction.',
    color: '#8b5cf6',
    avatar: 'leaf',
  },
  skills: [],
  routines: [],
};
const publication = {
  versionId: version,
  token: 'T'.repeat(43),
  digest: digest(blueprint),
  audience: 'team' as const,
  publishedAt: timestamp,
};
repository.save({
  id: template,
  workspaceId: source.id,
  createdBy: team.user.id,
  sourceAgentId: source.agent,
  sourceConversationId: source.chat,
  sourceName: 'Original fixture Bot',
  messageId: randomUUID(),
  sequence: 1,
  revision: randomUUID(),
  draftRevision: randomUUID(),
  draftDigest: digest(blueprint),
  blueprint,
  publication,
  revoked: false,
  projectionPending: false,
  createdAt: timestamp,
  updatedAt: timestamp,
});
repository.db.prepare('INSERT INTO template_versions VALUES(?,?,?,?,?)').run(
  version,
  template,
  source.id,
  JSON.stringify({
    id: version,
    templateId: template,
    workspaceId: source.id,
    blueprint,
    audience: 'team',
    digest: digest(blueprint),
    publishedAt: timestamp,
  }),
  null,
);
repository.db
  .prepare('INSERT INTO template_links VALUES(?,?,?,0)')
  .run(publication.token, template, version);
repository.db.close();
const shared = new DatabaseSync(join(directory, 'platform/shared-bots.sqlite'));
shared.exec(
  'CREATE TABLE shared_bots(id TEXT PRIMARY KEY,source_workspace_id TEXT NOT NULL,source_agent_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(source_workspace_id,source_agent_id)); CREATE TABLE shared_bot_mutations(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,share_id TEXT NOT NULL,PRIMARY KEY(actor_id,request_id))',
);
const share = randomUUID();
shared.prepare('INSERT INTO shared_bots VALUES(?,?,?,?)').run(
  share,
  source.id,
  source.agent,
  JSON.stringify({
    id: share,
    sourceWorkspaceId: source.id,
    sourceAgentId: source.agent,
    createdBy: team.user.id,
    targetTeamId: source.id,
    audience: 'team',
    memberIds: [],
    status: 'active',
    revision: randomUUID(),
    accessRevision: randomUUID(),
    files: [],
    apps: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);
shared.close();
writeFileSync(
  join(directory, 'fixture-private.json'),
  JSON.stringify({
    userId: person.user.id,
    session: token,
    identities,
    activePassword: 'synthetic-password-42',
  }),
  { mode: 0o600 },
);
writeFileSync(
  join(directory, 'platform/operator-setup-code'),
  'opaque-synthetic-code-never-decoded\n',
  { mode: 0o600 },
);
platform.close();
console.log(
  JSON.stringify({
    fixture: true,
    workspaces: identities.length,
    avatarSha256: createHash('sha256').update(avatarBytes).digest('hex'),
  }),
);

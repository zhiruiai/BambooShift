import type { BotBlueprint } from './bot-blueprint.js';

export type TemplateAudience = 'public' | 'team';
export type TemplateSharingMode = 'public' | 'team-only' | 'disabled';
export interface TemplateSharingPolicy {
  revision: string;
  mode: TemplateSharingMode;
}
export interface TemplatePublication {
  revision: string;
  digest: string;
  audience: TemplateAudience;
  path: string;
  publishedAt: string;
}
/** Owner view. Public readers receive only a published snapshot. */
export interface BotTemplate {
  id: string;
  sourceAgentId: string;
  sourceConversationId: string;
  messageId: string;
  sequence: number;
  revision: string;
  draftRevision: string;
  draftDigest: string;
  blueprint: BotBlueprint;
  avatarPath?: string;
  publication?: TemplatePublication;
  projectionPending: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface BotTemplateCard {
  templateId: string;
  sequence: number;
  name: string;
  status: 'draft' | 'published' | 'revoked';
  audience?: TemplateAudience;
  path?: string;
}
export interface PublishedBotTemplate {
  token: string;
  revision: string;
  digest: string;
  blueprint: BotBlueprint;
  audience: TemplateAudience;
  avatarPath?: string;
  publishedAt: string;
}
export interface BotTemplateSummary {
  token: string;
  name: string;
  role: string;
  description: string;
  avatar: BotBlueprint['profile']['avatar'];
  color: string;
  avatarPath?: string;
  audience: TemplateAudience;
  skillCount: number;
  routineCount: number;
  publishedAt: string;
}
export interface CreateBotTemplate {
  requestId: string;
  sourceAgentId: string;
  sourceConversationId: string;
  expectedSourceRevision: string;
}
export interface EditBotTemplate {
  requestId: string;
  expectedRevision: string;
  expectedDraftRevision: string;
  blueprint: BotBlueprint;
}
export interface RefreshBotTemplate {
  requestId: string;
  expectedRevision: string;
  expectedSourceRevision: string;
}
export interface PublishBotTemplate {
  requestId: string;
  expectedRevision: string;
  expectedDraftRevision: string;
  audience: TemplateAudience;
}
export interface RevokeBotTemplate {
  requestId: string;
  expectedRevision: string;
}
export const BOT_TEMPLATE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function botTemplatePath(token: string) {
  return BOT_TEMPLATE_TOKEN.test(token) ? `/templates/${token}` : undefined;
}
export function parseBotTemplatePath(path: string) {
  const match = /^\/templates\/([A-Za-z0-9_-]{43})\/?$/.exec(path);
  return match?.[1];
}

import type { BotAgent } from './types.js';

export interface BotBlueprint {
  version: 1;
  profile: Pick<BotAgent, 'name' | 'role' | 'description' | 'instructions' | 'color' | 'avatar'>;
  skills: Array<{ name: string; description: string; content: string }>;
  routines: Array<{
    title: string;
    prompt: string;
    schedule: string;
    enabled: boolean;
    timeZone?: string;
  }>;
  avatar?: { mimeType: 'image/webp'; sha256: string; width: 512; height: 512 };
}
export interface BotInstallSource {
  kind: 'bot' | 'template';
  id: string;
  revision: string;
}
export interface BotInstallReceipt {
  requestId: string;
  agentId: string;
  conversationId: string;
  skillIds: string[];
  routineIds: string[];
  createdAt: string;
}
export const BOT_BLUEPRINT_MAX_BYTES = 2 * 1024 * 1024;
export const BOT_BLUEPRINT_MAX_SKILLS = 100;
export const BOT_BLUEPRINT_MAX_ROUTINES = 100;

import { uiText } from './i18n';
import type { BotAgent, Message } from '../../shared/types';
import { validAvatarImageId } from './avatarImages';
import { botShapes as shapes } from './botProfiles';

export function removedAuthor(id: string): BotAgent {
  return {
    id,
    name: uiText('common:text_0583e9855b7b'),
    role: '',
    description: '',
    color: '#a59caa',
    avatar: 'orb',
    instructions: '',
    status: 'idle',
  };
}

export function historicalAuthor(message: Message): BotAgent | undefined {
  const value = message.metadata?.author;
  if (!value || typeof value !== 'object') return;
  const author = value as Record<string, unknown>;
  if (typeof author.name !== 'string') return;
  const base = removedAuthor(message.agentId || String(author.id || 'removed'));
  return {
    ...base,
    name: author.name,
    role: typeof author.role === 'string' ? author.role : '',
    color:
      typeof author.color === 'string' && /^#[\da-f]{6}$/i.test(author.color)
        ? author.color
        : base.color,
    avatar: shapes.includes(author.avatar as BotAgent['avatar'])
      ? (author.avatar as BotAgent['avatar'])
      : base.avatar,
    avatarImageId: validAvatarImageId(author.avatarImageId) ? author.avatarImageId : null,
  };
}

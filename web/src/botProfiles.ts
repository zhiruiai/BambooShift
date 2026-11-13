import { uiText, localizedData } from './i18n';
import type { BotAgent } from '../../shared/types';
import { validAvatarImageId } from './avatarImages';
import { AVATAR_COLORS } from '../../shared/avatar-palette';
export type BotProfileDraft = Pick<
  BotAgent,
  'name' | 'role' | 'description' | 'instructions' | 'color' | 'avatar' | 'avatarImageId'
>;
export const botColors = AVATAR_COLORS;
export const botShapes: BotAgent['avatar'][] = ['orb', 'drop', 'leaf', 'spark', 'gem', 'arch'];
export const botShapeNames = localizedData(() => ({
  orb: uiText('bots:text_89ccaeea7d02'),
  drop: uiText('bots:text_996b8536849b'),
  leaf: uiText('bots:text_c6dfb2b17bb0'),
  spark: uiText('bots:text_9f62cd8bb760'),
  gem: uiText('bots:text_9b94e941bef0'),
  arch: uiText('bots:text_296c658663d7'),
}));
export function botProfileDraft(agent?: BotAgent): BotProfileDraft {
  return {
    name: agent?.name || '',
    role: agent?.role || '',
    description: agent?.description || '',
    instructions: agent?.instructions || '',
    color: agent?.color || botColors[0],
    avatar: agent?.avatar || 'orb',
    avatarImageId: agent?.avatarImageId ?? null,
  };
}
export function botProfileProblem(draft: BotProfileDraft) {
  if (!draft.name.trim() || draft.name.length > 40) return uiText('bots:text_4801ed294538');
  if (!draft.role.trim() || draft.role.length > 80) return uiText('bots:text_09dcc9123bd0');
  if (draft.description.length > 1000) return uiText('bots:text_71b3bd9c1bcf');
  if (draft.instructions.length > 16000) return uiText('bots:text_aa5a02bce65d');
  if (!/^#[\da-f]{6}$/i.test(draft.color) || !botShapes.includes(draft.avatar))
    return uiText('bots:text_9bc83528ca7b');
  if (draft.avatarImageId != null && !validAvatarImageId(draft.avatarImageId))
    return uiText('bots:text_31a93dc77b6f');
  return '';
}

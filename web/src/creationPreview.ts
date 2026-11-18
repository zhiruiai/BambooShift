import { AVATAR_SHAPES } from './avatarThemeCatalog';
import { botProfileProblem, type BotProfileDraft } from './botProfiles';
import {
  exactRecord,
  generatedAvatarTheme,
  type GeneratedAvatarTheme,
} from './generatedAvatarTheme';
export {
  generatedAvatarTheme,
  THEME_BADGES,
  THEME_BACKDROPS,
  type GeneratedAvatarTheme,
} from './generatedAvatarTheme';

export type CreationPreview =
  { kind: 'bot'; profile: BotProfileDraft } | { kind: 'theme'; theme: GeneratedAvatarTheme };
export function parseCreationPreview(
  kind: CreationPreview['kind'],
  value: unknown,
): CreationPreview | undefined {
  const response = exactRecord(value, ['kind', kind === 'bot' ? 'profile' : 'theme']);
  if (!response || response.kind !== kind) return;
  if (kind === 'theme') {
    const theme = generatedAvatarTheme(response.theme);
    return theme && { kind, theme };
  }
  const profile = exactRecord(response.profile, [
    'name',
    'role',
    'description',
    'instructions',
    'avatar',
    'color',
    'avatarImageId',
  ]);
  if (
    !profile ||
    profile.avatarImageId !== null ||
    !['name', 'role', 'description', 'instructions', 'avatar', 'color'].every(
      (key) => typeof profile[key] === 'string',
    ) ||
    !AVATAR_SHAPES.includes(profile.avatar as BotProfileDraft['avatar'])
  )
    return;
  const draft = profile as BotProfileDraft;
  if (!botProfileProblem(draft)) return { kind, profile: { ...draft } };
}

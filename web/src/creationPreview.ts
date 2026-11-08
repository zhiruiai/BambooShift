import { AVATAR_SHAPES, AVATAR_THEMES, type AvatarTheme } from './avatarThemes';
import { botProfileProblem, type BotProfileDraft } from './botProfiles';

export const THEME_BADGES = ['none', 'star', 'flower', 'moon', 'bolt'] as const;
export const THEME_BACKDROPS = ['plain', 'halo', 'solid'] as const;
export type GeneratedAvatarTheme = Readonly<{
  name: string;
  motif: AvatarTheme;
  colors: readonly [string, string, string];
  badge: (typeof THEME_BADGES)[number];
  backdrop: (typeof THEME_BACKDROPS)[number];
}>;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)))
    return record;
}

export function generatedAvatarTheme(value: unknown): GeneratedAvatarTheme | undefined {
  const theme = exactRecord(value, ['name', 'motif', 'colors', 'badge', 'backdrop']);
  if (!theme) return;
  const { name, motif, colors, badge, backdrop } = theme;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 40 ||
    !/^[\p{L}\p{N} '’·-]+$/u.test(name) ||
    !AVATAR_THEMES.includes(motif as AvatarTheme) ||
    !THEME_BADGES.includes(badge as GeneratedAvatarTheme['badge']) ||
    !THEME_BACKDROPS.includes(backdrop as GeneratedAvatarTheme['backdrop']) ||
    !Array.isArray(colors) ||
    colors.length !== 3 ||
    !colors.every((color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))
  )
    return;
  const palette = colors.map((color) => color.toLowerCase()) as [string, string, string];
  if (new Set(palette).size !== 3) return;
  return Object.freeze({
    name: name.trim(),
    motif: motif as AvatarTheme,
    colors: Object.freeze(palette),
    badge: badge as GeneratedAvatarTheme['badge'],
    backdrop: backdrop as GeneratedAvatarTheme['backdrop'],
  });
}

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

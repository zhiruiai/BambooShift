import catalog from '../../shared/avatar-packs/catalog.json';
import classic from '../../shared/avatar-classic.json';
import { AVATAR_ROLE_COLORS, displayAvatarColor } from '../../shared/avatar-palette';
import { uiText, localizedData, currentLanguage } from './i18n';

export const ORIGINAL_AVATAR_THEMES = [
  'companions',
  'pandas',
  'dinosaurs',
  'chicks',
  'elephants',
] as const;
export type OriginalAvatarTheme = (typeof ORIGINAL_AVATAR_THEMES)[number];
export type CommunityAvatarTheme = `open-avatar-${string}` | `grokbot-${string}`;
export const DEFAULT_AVATAR_THEME = 'classic' as const;
export const CLASSIC_AVATAR = classic;
export type AvatarTheme = OriginalAvatarTheme | CommunityAvatarTheme | typeof DEFAULT_AVATAR_THEME;
export const BUILTIN_AVATAR_THEMES = [DEFAULT_AVATAR_THEME, ...ORIGINAL_AVATAR_THEMES] as const;
export const COMMUNITY_AVATAR_PACKS = catalog.packs;
export const AVATAR_THEMES: readonly AvatarTheme[] = [
  ...BUILTIN_AVATAR_THEMES,
  ...catalog.packs.flatMap((pack) => pack.themes.map((theme) => theme.id as CommunityAvatarTheme)),
];
export const AVATAR_THEME_NAMES: Record<AvatarTheme, string> = localizedData(() => ({
  classic: currentLanguage() === 'en' ? classic.label.en : classic.label.zh,
  companions: uiText('common:text_ae47ea41c651'),
  pandas: uiText('common:text_e9f782e9c2b6'),
  dinosaurs: uiText('common:text_a44f0b389a75'),
  chicks: uiText('common:avatarThemeChicks'),
  elephants: uiText('common:avatarThemeElephants'),
  ...Object.fromEntries(
    catalog.packs.flatMap((pack) =>
      pack.themes.map((theme) => [
        theme.id,
        currentLanguage() === 'en' ? theme.label.en : theme.label.zh,
      ]),
    ),
  ),
}));
export const AVATAR_SHAPES = ['orb', 'drop', 'leaf', 'spark', 'gem', 'arch'] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export function isOriginalAvatarTheme(value: AvatarTheme): value is OriginalAvatarTheme {
  return (ORIGINAL_AVATAR_THEMES as readonly string[]).includes(value);
}
export function avatarTheme(value: unknown): AvatarTheme {
  return AVATAR_THEMES.includes(value as AvatarTheme)
    ? (value as AvatarTheme)
    : DEFAULT_AVATAR_THEME;
}
export function avatarShape(value: unknown): AvatarShape {
  return AVATAR_SHAPES.includes(value as AvatarShape) ? (value as AvatarShape) : 'orb';
}
export function avatarColor(value: unknown, shape?: string): string {
  return displayAvatarColor(value, AVATAR_ROLE_COLORS[avatarShape(shape)]);
}

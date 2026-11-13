import catalog from '../../shared/avatar-packs/catalog.json';
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
export type AvatarTheme = OriginalAvatarTheme | CommunityAvatarTheme;
export const COMMUNITY_AVATAR_PACKS = catalog.packs;
export const AVATAR_THEMES: readonly AvatarTheme[] = [
  ...ORIGINAL_AVATAR_THEMES,
  ...catalog.packs.flatMap((pack) => pack.themes.map((theme) => theme.id as CommunityAvatarTheme)),
];
export const AVATAR_THEME_NAMES: Record<AvatarTheme, string> = localizedData(() => ({
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
  return AVATAR_THEMES.includes(value as AvatarTheme) ? (value as AvatarTheme) : 'companions';
}
export function avatarShape(value: unknown): AvatarShape {
  return AVATAR_SHAPES.includes(value as AvatarShape) ? (value as AvatarShape) : 'orb';
}
export function avatarColor(value: unknown): string {
  return typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : '#8a61ee';
}

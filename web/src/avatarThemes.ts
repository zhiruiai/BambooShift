import { uiText, localizedData } from './i18n';
export const AVATAR_THEMES = ['companions', 'pandas', 'dinosaurs', 'chicks', 'elephants'] as const;
export type AvatarTheme = (typeof AVATAR_THEMES)[number];
export const AVATAR_THEME_NAMES: Record<AvatarTheme, string> = localizedData(() => ({
  companions: uiText('common:text_ae47ea41c651'),
  pandas: uiText('common:text_e9f782e9c2b6'),
  dinosaurs: uiText('common:text_a44f0b389a75'),
  chicks: uiText('common:avatarThemeChicks'),
  elephants: uiText('common:avatarThemeElephants'),
}));
export const AVATAR_SHAPES = ['orb', 'drop', 'leaf', 'spark', 'gem', 'arch'] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export function avatarTheme(value: unknown): AvatarTheme {
  return AVATAR_THEMES.includes(value as AvatarTheme) ? (value as AvatarTheme) : 'companions';
}
export function avatarShape(value: unknown): AvatarShape {
  return AVATAR_SHAPES.includes(value as AvatarShape) ? (value as AvatarShape) : 'orb';
}
export function avatarColor(value: unknown): string {
  return typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : '#8a61ee';
}

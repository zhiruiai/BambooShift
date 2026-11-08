import type { AppearancePreferences } from './appearance';
import { AVATAR_THEMES, type AvatarTheme } from './avatarThemes';
import { generatedAvatarTheme, type GeneratedAvatarTheme } from './creationPreview';

export type AvatarThemePatch = Pick<
  AppearancePreferences,
  'avatarTheme' | 'customAvatarTheme' | 'useCustomAvatarTheme'
>;
export type SyncedAvatarTheme = {
  avatarTheme: AvatarTheme;
  customAvatarTheme: GeneratedAvatarTheme | null;
  useCustomAvatarTheme: boolean;
};
export type AvatarThemeSnapshot = { theme: SyncedAvatarTheme | null; revision: number };

export function avatarThemeSelection(value: AvatarThemePatch): SyncedAvatarTheme {
  return {
    avatarTheme: value.avatarTheme,
    customAvatarTheme: value.customAvatarTheme ?? null,
    useCustomAvatarTheme: !!value.customAvatarTheme && value.useCustomAvatarTheme === true,
  };
}

export function avatarThemeAppearance(value: SyncedAvatarTheme): AvatarThemePatch {
  return { ...value, customAvatarTheme: value.customAvatarTheme ?? undefined };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function parseAvatarThemeSnapshot(value: unknown): AvatarThemeSnapshot | undefined {
  const state = object(value);
  if (
    !state ||
    typeof state.revision !== 'number' ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  )
    return;
  if (state.theme === null) return { theme: null, revision: state.revision };
  const choice = object(state.theme);
  if (
    !choice ||
    !AVATAR_THEMES.includes(choice.avatarTheme as AvatarTheme) ||
    typeof choice.useCustomAvatarTheme !== 'boolean'
  )
    return;
  const custom =
    choice.customAvatarTheme === null ? null : generatedAvatarTheme(choice.customAvatarTheme);
  if (custom === undefined || (choice.useCustomAvatarTheme && !custom)) return;
  return {
    revision: state.revision,
    theme: {
      avatarTheme: choice.avatarTheme as AvatarTheme,
      customAvatarTheme: custom,
      useCustomAvatarTheme: choice.useCustomAvatarTheme,
    },
  };
}

export function sameAvatarTheme(a: SyncedAvatarTheme | null, b: SyncedAvatarTheme | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}

import classic from '../../shared/avatar-classic.json';
import colorful from '../../shared/avatar-colorful.json';
import { localizedData, currentLanguage, uiText } from './i18n';
import { COMMUNITY_AVATAR_PACKS, type AvatarTheme } from './avatarThemeCatalog';
export * from './avatarThemeCatalog';

export const AVATAR_THEME_NAMES: Record<AvatarTheme, string> = localizedData(() => ({
  colorful: currentLanguage() === 'en' ? colorful.label.en : colorful.label.zh,
  classic: currentLanguage() === 'en' ? classic.label.en : classic.label.zh,
  companions: uiText('common:text_ae47ea41c651'),
  pandas: uiText('common:text_e9f782e9c2b6'),
  dinosaurs: uiText('common:text_a44f0b389a75'),
  chicks: uiText('common:avatarThemeChicks'),
  elephants: uiText('common:avatarThemeElephants'),
  ...Object.fromEntries(
    COMMUNITY_AVATAR_PACKS.flatMap((pack) =>
      pack.themes.map((theme) => [
        theme.id,
        currentLanguage() === 'en' ? theme.label.en : theme.label.zh,
      ]),
    ),
  ),
}));

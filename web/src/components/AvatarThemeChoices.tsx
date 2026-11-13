import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import {
  AVATAR_THEME_NAMES,
  ORIGINAL_AVATAR_THEMES,
  COMMUNITY_AVATAR_PACKS,
  type AvatarTheme,
} from '../avatarThemes';
import { uiText } from '../i18n';
import { AvatarArtwork } from './AvatarArtwork';
import { AVATAR_ROLE_COLORS } from '../../../shared/avatar-palette';

const family = (theme: AvatarTheme) =>
  COMMUNITY_AVATAR_PACKS.find((pack) => pack.themes.some((item) => item.id === theme))?.id ??
  'originals';

export function AvatarThemeChoices({
  value,
  custom = false,
  disabled = false,
  onChange,
}: {
  value: AvatarTheme;
  custom?: boolean;
  disabled?: boolean;
  onChange: (theme: AvatarTheme) => void;
}) {
  const [group, setGroup] = useState(() => family(value));
  useEffect(() => setGroup(family(value)), [value]);
  const groups = [
    {
      id: 'originals',
      name: uiText('settings:avatarOriginalCollection'),
      count: ORIGINAL_AVATAR_THEMES.length,
    },
    ...COMMUNITY_AVATAR_PACKS.map((pack) => ({
      id: pack.id,
      name: pack.name,
      count: pack.themes.length,
    })),
  ];
  const themes =
    group === 'originals'
      ? ORIGINAL_AVATAR_THEMES
      : COMMUNITY_AVATAR_PACKS.find((pack) => pack.id === group)!.themes.map(
          (item) => item.id as AvatarTheme,
        );
  return (
    <div className="avatar-theme-catalog">
      <div
        className="avatar-theme-families"
        role="group"
        aria-label={uiText('settings:avatarCollections')}
      >
        {groups.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={disabled}
            aria-pressed={group === item.id}
            onClick={() => setGroup(item.id)}
          >
            {item.name}
            <span>{item.count}</span>
          </button>
        ))}
      </div>
      <div className="avatar-theme-catalog-heading">
        <span>{groups.find((item) => item.id === group)!.name}</span>
        <span>
          {uiText('settings:avatarSelectedTheme', {
            name: custom ? uiText('settings:avatarCustomTheme') : AVATAR_THEME_NAMES[value],
          })}
        </span>
      </div>
      <div
        className="appearance-avatar-options avatar-theme-catalog-grid"
        data-collection={group}
        role="group"
        aria-label={groups.find((item) => item.id === group)!.name}
        tabIndex={0}
      >
        {themes.map((theme) => (
          <button
            key={theme}
            type="button"
            className="appearance-avatar-option"
            data-theme-choice={theme}
            aria-label={AVATAR_THEME_NAMES[theme]}
            aria-pressed={!custom && value === theme}
            disabled={disabled}
            onClick={() => onChange(theme)}
          >
            <span className="appearance-avatar-preview" aria-hidden="true">
              <AvatarArtwork theme={theme} shape="orb" color={AVATAR_ROLE_COLORS.orb} size={46} />
              {group === 'originals' && (
                <>
                  <AvatarArtwork
                    theme={theme}
                    shape="leaf"
                    color={AVATAR_ROLE_COLORS.leaf}
                    size={36}
                  />
                  <AvatarArtwork
                    theme={theme}
                    shape="arch"
                    color={AVATAR_ROLE_COLORS.arch}
                    size={36}
                  />
                </>
              )}
            </span>
            <span>{AVATAR_THEME_NAMES[theme]}</span>
            {!custom && value === theme && (
              <Check className="avatar-theme-selected" size={14} aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
      {group !== 'originals' && (
        <p className="avatar-theme-collection-note">
          {uiText('settings:avatarCommunityNote')}
          {' · '}
          <a href={`/licenses/${group}.html`} target="_blank" rel="noopener noreferrer">
            {uiText('settings:avatarCollectionLicense')}
          </a>
        </p>
      )}
    </div>
  );
}

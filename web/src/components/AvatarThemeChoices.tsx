import { useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  AVATAR_THEME_NAMES,
  BUILTIN_AVATAR_THEMES,
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
  const [page, setPage] = useState(0);
  useEffect(() => setGroup(family(value)), [value]);
  const groups = [
    {
      id: 'originals',
      name: uiText('settings:avatarOriginalCollection'),
      count: BUILTIN_AVATAR_THEMES.length,
    },
    ...COMMUNITY_AVATAR_PACKS.map((pack) => ({
      id: pack.id,
      name: pack.name,
      count: pack.themes.length,
    })),
  ];
  const themes =
    group === 'originals'
      ? BUILTIN_AVATAR_THEMES
      : COMMUNITY_AVATAR_PACKS.find((pack) => pack.id === group)!.themes.map(
          (item) => item.id as AvatarTheme,
        );
  const pages = Math.ceil(themes.length / 8);
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    const choices =
      group === 'originals'
        ? BUILTIN_AVATAR_THEMES
        : COMMUNITY_AVATAR_PACKS.find((pack) => pack.id === group)!.themes.map((item) => item.id);
    setPage(Math.max(0, Math.floor(choices.findIndex((theme) => theme === value) / 8)));
  }, [group, value]);
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
      >
        {themes.slice(currentPage * 8, currentPage * 8 + 8).map((theme) => (
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
              <AvatarArtwork
                theme={theme}
                shape="orb"
                color={AVATAR_ROLE_COLORS.orb}
                size={46}
                faceMotion={
                  ['classic', 'colorful'].includes(theme) && !custom && value === theme
                    ? { state: 'idle', sustain: true }
                    : undefined
                }
              />
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
      {pages > 1 && (
        <div
          className="avatar-theme-pages"
          role="group"
          aria-label={uiText('settings:avatarThemePages')}
        >
          <button
            type="button"
            disabled={disabled || currentPage === 0}
            aria-label={uiText('settings:avatarPreviousPage')}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span aria-live="polite">
            {currentPage + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={disabled || currentPage + 1 === pages}
            aria-label={uiText('settings:avatarNextPage')}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      {(group !== 'originals' || ['classic', 'colorful'].includes(value)) && (
        <p className="avatar-theme-collection-note">
          {uiText('settings:avatarCommunityNote')}
          {' · '}
          <a
            href={`/licenses/${group === 'originals' ? 'grokbot' : group}.html`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {uiText('settings:avatarCollectionLicense')}
          </a>
        </p>
      )}
    </div>
  );
}

import { LanguageSettings } from './LanguageSettings';
import { uiText } from '../i18n';
import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { AppearancePreferences } from '../appearance';
import { useAvatarAppearance } from '../avatarAppearance';
import type { AvatarThemePatch } from '../avatarThemeSync';
import { AvatarThemeSyncPanel } from './AvatarThemeSyncPanel';
import { AvatarThemeChoices } from './AvatarThemeChoices';
import { CreationBrief } from './CreationBrief';
import { GeneratedAvatarArtwork } from './GeneratedAvatarArtwork';
import './AppearanceSettings.css';

export function AppearanceSettings({
  active = true,
  generation,
}: {
  active?: boolean;
  generation?: { workspaceId: string; userId: string; configured: boolean };
}) {
  const appearance = useAvatarAppearance();
  const visible = useRef(active),
    mounted = useRef(true);
  visible.current = active;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function update(patch: Partial<AppearancePreferences>) {
    if (mounted.current && visible.current) appearance.update(patch);
  }
  function updateAvatar(patch: Partial<AvatarThemePatch>) {
    if (mounted.current && visible.current) appearance.updateAvatar(patch);
  }
  return (
    <section className="appearance-settings" aria-label={uiText('settings:text_8858d253663e')}>
      <h3>{uiText('settings:text_8858d253663e')}</h3>
      <div className="appearance-preferences-card">
        <label className="appearance-setting-row">
          <span>{uiText('settings:text_86a63f23a076')}</span>
          <select
            aria-label={uiText('settings:text_86a63f23a076')}
            value={appearance.theme}
            disabled={!active}
            onChange={(event) =>
              update({ theme: event.target.value as AppearancePreferences['theme'] })
            }
          >
            <option value="system">{uiText('settings:text_217cfe7db1e3')}</option>
            <option value="light">{uiText('settings:text_aa0819dfc4d8')}</option>
            <option value="dark">{uiText('settings:text_a6b75d068032')}</option>
          </select>
        </label>
        <label className="appearance-setting-row">
          <span>{uiText('settings:text_f84e05423960')}</span>
          <select
            aria-label={uiText('settings:text_f84e05423960')}
            value={appearance.accent}
            disabled={!active}
            onChange={(event) =>
              update({ accent: event.target.value as AppearancePreferences['accent'] })
            }
          >
            <option value="bot">{uiText('settings:text_b246acb317b9')}</option>
            <option value="neutral">{uiText('settings:text_47d88357c5ea')}</option>
          </select>
        </label>
        <LanguageSettings active={active} compact />
        <label className="appearance-setting-row appearance-spellcheck">
          <span>{uiText('settings:text_c664a44a8454')}</span>
          <input
            type="checkbox"
            checked={appearance.spellCheck}
            disabled={!active}
            onChange={(event) => update({ spellCheck: event.target.checked })}
          />
        </label>
      </div>
      <p className="field-help">
        {uiText(
          appearance.avatarSync
            ? 'settings:avatarSyncDevicePreferences'
            : 'settings:text_dd3fa14e0339',
        )}
      </p>
      <div
        className="appearance-avatar-themes"
        role="group"
        aria-label={uiText('settings:text_cd8b6722e7e4')}
      >
        <span className="appearance-avatar-heading">{uiText('settings:text_cd8b6722e7e4')}</span>
        <AvatarThemeChoices
          value={appearance.avatarTheme}
          custom={appearance.useCustomAvatarTheme}
          disabled={!active}
          onChange={(avatarTheme) => updateAvatar({ avatarTheme, useCustomAvatarTheme: false })}
        />
        <div className="appearance-avatar-options appearance-custom-avatar">
          {appearance.customAvatarTheme && (
            <button
              type="button"
              className="appearance-avatar-option"
              aria-pressed={!!appearance.useCustomAvatarTheme}
              disabled={!active}
              onClick={() => updateAvatar({ useCustomAvatarTheme: true })}
            >
              <span className="appearance-avatar-preview" aria-hidden="true">
                {(['orb', 'leaf', 'gem'] as const).map((shape) => (
                  <GeneratedAvatarArtwork
                    key={shape}
                    theme={appearance.customAvatarTheme!}
                    shape={shape}
                    size={36}
                  />
                ))}
              </span>
              <span>{appearance.customAvatarTheme.name}</span>
              <small>
                {appearance.useCustomAvatarTheme && <Check size={13} aria-hidden="true" />}
                {uiText(
                  appearance.useCustomAvatarTheme
                    ? 'settings:text_3f4ebc4aad97'
                    : 'settings:text_37aea2b389a4',
                )}
              </small>
            </button>
          )}
        </div>
        <p className="field-help">{uiText('settings:text_65f33f62421f')}</p>
        {appearance.avatarSync && (
          <AvatarThemeSyncPanel sync={appearance.avatarSync} active={active} />
        )}
        {generation && (
          <CreationBrief
            {...generation}
            kind="theme"
            active={active}
            onUse={(draft) => {
              if (draft.kind === 'theme')
                updateAvatar({ customAvatarTheme: draft.theme, useCustomAvatarTheme: true });
            }}
          />
        )}
      </div>
      {!appearance.storageAvailable && (
        <p className="appearance-persistence-note" role="status">
          {uiText('settings:text_b4f7097dbe7a')}
        </p>
      )}
    </section>
  );
}

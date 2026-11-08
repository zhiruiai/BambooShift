import { useEffect, useState } from 'react';
import { uiText, type UiTextKey } from '../i18n';
import type { useWorkspaceAvatarTheme } from '../useWorkspaceAvatarTheme';

type Sync = ReturnType<typeof useWorkspaceAvatarTheme>;
const messages: Record<Exclude<Sync['phase'], 'ready'>, UiTextKey> = {
  loading: 'settings:avatarSyncLoading',
  checking: 'settings:avatarSyncLoading',
  saving: 'settings:avatarSyncSaving',
  conflict: 'settings:avatarSyncConflict',
  unknown: 'settings:avatarSyncUnknown',
  unavailable: 'settings:avatarSyncUnavailable',
};

export function AvatarThemeSyncPanel({ sync, active }: { sync: Sync; active: boolean }) {
  const ready = sync.phase === 'ready';
  const canClear = active && ready && sync.synced;
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!canClear) setConfirmClear(false);
  }, [canClear]);
  const status =
    sync.phase !== 'ready'
      ? messages[sync.phase]
      : sync.preview
        ? 'settings:avatarSyncPreview'
        : sync.synced
          ? 'settings:avatarSyncSaved'
          : 'settings:avatarSyncDevice';
  return (
    <section className="avatar-theme-sync" aria-label={uiText('settings:avatarSyncTitle')}>
      <h4>{uiText('settings:avatarSyncTitle')}</h4>
      <p>{uiText('settings:avatarSyncHelp')}</p>
      <p role="status">{uiText(status)}</p>
      {sync.synced && <p>{uiText('settings:avatarSyncClearHelp')}</p>}
      <div className="avatar-theme-sync-actions">
        <button
          type="button"
          className="primary-button"
          disabled={!active || !ready || confirmClear || (sync.synced && !sync.preview)}
          onClick={() => void sync.save()}
        >
          {uiText('settings:avatarSyncSave')}
        </button>
        {sync.synced && (
          <button
            type="button"
            className="secondary-button"
            disabled={!canClear || confirmClear}
            onClick={() => setConfirmClear(true)}
          >
            {uiText('settings:avatarSyncClear')}
          </button>
        )}
        {sync.preview && (
          <button
            type="button"
            className="secondary-button"
            disabled={!active || !ready || confirmClear}
            onClick={sync.restore}
          >
            {uiText(sync.synced ? 'settings:avatarSyncRestore' : 'settings:avatarSyncDiscard')}
          </button>
        )}
        {!ready && !sync.busy && (
          <button
            type="button"
            className="secondary-button"
            disabled={!active}
            onClick={() => void sync.check()}
          >
            {uiText('settings:avatarSyncCheck')}
          </button>
        )}
      </div>
      {canClear && confirmClear && (
        <div
          className="avatar-theme-sync-confirm"
          role="group"
          aria-label={uiText('settings:avatarSyncClearPrompt')}
        >
          <p>{uiText('settings:avatarSyncClearPrompt')}</p>
          <div className="avatar-theme-sync-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirmClear(false)}
            >
              {uiText('common:cancel')}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setConfirmClear(false);
                void sync.clear();
              }}
            >
              {uiText('settings:avatarSyncClearConfirm')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

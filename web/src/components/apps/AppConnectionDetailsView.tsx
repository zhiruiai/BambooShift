import { serviceText } from '../../i18n/serviceText';
import { uiText } from '../../i18n';
import { Loader2, RefreshCw, Trash2, Unplug } from 'lucide-react';
import type { ConnectedApp } from '../../../../shared/app-connections';
import { appConnectionStatus } from '../../appConnections';
import { AppOAuthPanel } from '../AppOAuthPanel';
import { AppPolicyPanel } from './AppPolicyPanel';
import '../AppsDialog.css';
import { AppToolListView } from './AppToolListView';
import { checked } from './parts';
import type { useAppsDialogContent } from './useAppsDialogContent';
export type AppsDialogContentModel = ReturnType<typeof useAppsDialogContent>;
export function AppConnectionDetailsView(model: AppsDialogContentModel) {
  const {
    view,
    selectedApp,
    props,
    close,
    busy,
    navigate,
    error,
    notice,
    uncertain,
    loading,
    refresh,
    search,
    setSearch,
    apps,
    visible,
    draft,
    setError,
    mutate,
    scope,
    setDraft,
    ownBusy,
    oauthBusyRef,
    setOAuthBusy,
    reconnect,
    confirm,
    setReauthorize,
    reauthorize,
    setToken,
    setConfirm,
    token,
  } = model;
  return !selectedApp ? (
    <div className="apps-empty">
      <p>{uiText('apps:text_a4525544b7af')}</p>
    </div>
  ) : (
    <>
      <div className="apps-connection-summary">
        <span className={`apps-status app-status-${selectedApp.status}`}>
          {appConnectionStatus(selectedApp.status)}
        </span>
        <p>{selectedApp.url}</p>
        <small>
          {selectedApp.authType === 'bearer'
            ? selectedApp.hasCredential
              ? uiText('apps:text_e3e981c1623f')
              : uiText('apps:text_d18e616c40f8')
            : selectedApp.authType === 'oauth'
              ? uiText('apps:text_6328ea1156ca')
              : uiText('apps:text_41dda397a0fa')}{' '}
          {uiText('apps:text_d9dcf2b663cc')}
          {checked(selectedApp.checkedAt)}
        </small>
        {selectedApp.error && <p className="error-text">{serviceText(selectedApp.error)}</p>}
        {selectedApp.authorization && (
          <details>
            <summary>{uiText('apps:text_7c96762094e6')}</summary>
            <p>{selectedApp.authorization.issuer}</p>
            <ul>
              {selectedApp.authorization.scopes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
        )}
        {selectedApp.revocation && (
          <p className="field-help" role="status">
            {
              {
                pending: uiText('apps:text_1b7e5d4f2a51'),
                revoked: uiText('apps:text_0920d50f3215'),
                unavailable: uiText('apps:text_aba75b00ff2f'),
                failed: uiText('apps:text_a153d92a839f'),
              }[selectedApp.revocation]
            }
          </p>
        )}
        {selectedApp.revocation === 'pending' && (
          <button
            type="button"
            className="text-button"
            disabled={busy || loading}
            onClick={() => void refresh()}
          >
            {uiText('apps:text_6991a505f676')}
          </button>
        )}
      </div>
      <AppToolListView {...model} />
      {props.canManage && (
        <>
          {selectedApp.authType === 'oauth' && (
            <>
              <AppOAuthPanel
                app={selectedApp}
                workspaceId={props.workspaceId}
                userId={props.userId}
                disabled={ownBusy || uncertain}
                onBusy={(value) => {
                  oauthBusyRef.current = value;
                  setOAuthBusy(value);
                }}
                onChanged={() => {
                  void refresh();
                  props.onChanged?.();
                }}
              />
              {selectedApp.hasCredential && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || uncertain}
                  onClick={() => reconnect(false)}
                >
                  <RefreshCw size={15} />
                  {uiText('apps:text_5f05fa8061d8')}
                </button>
              )}
            </>
          )}
          {selectedApp.authType !== 'oauth' && (
            <>
              <div className="apps-controls">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    busy ||
                    uncertain ||
                    (selectedApp.authType === 'bearer' && !selectedApp.hasCredential)
                  }
                  onClick={() => reconnect(false)}
                >
                  <RefreshCw size={15} className={busy && !confirm ? 'spin' : ''} />
                  {selectedApp.status === 'disconnected'
                    ? uiText('apps:text_68891ab35cab')
                    : uiText('apps:text_5f05fa8061d8')}
                </button>
                {(selectedApp.authType === 'bearer' || selectedApp.status === 'needs_auth') && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || uncertain}
                    onClick={() => {
                      setReauthorize(!reauthorize);
                      setToken('');
                      setConfirm(null);
                    }}
                  >
                    {uiText('apps:text_6a84698a4758')}
                  </button>
                )}
              </div>
              {reauthorize && (
                <form
                  className="dialog-form apps-reauthorize"
                  onSubmit={(event) => {
                    event.preventDefault();
                    reconnect(true);
                  }}
                >
                  <label>
                    {uiText('apps:text_20c0008606b5')}
                    <input
                      required
                      type="password"
                      value={token}
                      disabled={busy}
                      autoComplete="new-password"
                      onChange={(event) => setToken(event.target.value)}
                      placeholder={uiText('apps:text_b0b8fea22f4a')}
                    />
                  </label>
                  <p className="field-help">{uiText('apps:text_3b21ae105d97')}</p>
                  <div className="dialog-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => {
                        setReauthorize(false);
                        setToken('');
                      }}
                    >
                      {uiText('apps:text_2cd0f3be8738')}
                    </button>
                    <button
                      className="primary-button"
                      disabled={busy || uncertain || !token.trim()}
                    >
                      {busy && <Loader2 size={15} className="spin" />}
                      {uiText('apps:text_74ab15d7f86f')}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
          <div className="apps-danger-controls">
            <button
              type="button"
              className="text-button"
              disabled={busy || uncertain || selectedApp.status === 'disconnected'}
              onClick={() => {
                setConfirm('disconnect');
                setReauthorize(false);
                setToken('');
              }}
            >
              <Unplug size={14} />
              {uiText('apps:text_a33f3804768e')}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy || uncertain}
              onClick={() => {
                setConfirm('remove');
                setReauthorize(false);
                setToken('');
              }}
            >
              <Trash2 size={14} />
              {uiText('apps:text_c95e647c471d')}
            </button>
          </div>
          {confirm && (
            <div className="agent-delete-confirm">
              <strong>
                {confirm === 'remove'
                  ? uiText('apps:text_6135d4159e89')
                  : uiText('apps:text_f33ac04eece6')}
                {uiText('common:punct_b269e4a0914b')}
                {selectedApp.name}
                {uiText('common:punct_a33706e414ed')}
              </strong>
              <p>
                {uiText('apps:text_c27b237d13e1')}
                {selectedApp.authType === 'oauth' && uiText('apps:text_589105028ecb')}
                {confirm === 'remove'
                  ? uiText('apps:text_32d65b83c704')
                  : uiText('apps:text_045678b97891')}
              </p>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  {uiText('apps:text_2cd0f3be8738')}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy || uncertain}
                  onClick={() => {
                    const removing = confirm === 'remove';
                    void mutate(
                      () =>
                        scope.request<ConnectedApp | void>(
                          `/apps/${encodeURIComponent(selectedApp.id)}${removing ? '' : '/disconnect'}`,
                          removing ? 'DELETE' : 'POST',
                          removing ? undefined : {},
                        ),
                      (removing
                        ? uiText('apps:text_5b1ac0436cb2')
                        : uiText('apps:text_4389885cc7ce')) +
                        (removing && selectedApp.authType === 'oauth'
                          ? uiText('apps:text_fb4b87eed61c')
                          : ''),
                      removing,
                    );
                  }}
                >
                  {busy && <Loader2 size={15} className="spin" />}
                  {uiText('apps:text_36f33adaf094')}
                  {confirm === 'remove'
                    ? uiText('apps:text_6135d4159e89')
                    : uiText('apps:text_f33ac04eece6')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {selectedApp && props.canManage && (
        <AppPolicyPanel
          app={selectedApp}
          userId={props.userId}
          workspaceId={props.workspaceId}
          canManage={props.canManage && !ownBusy && !model.oauthBusyRef.current && !model.toolIssue}
          toolAccessEpoch={model.toolPolicyEpoch}
          onBusy={model.setPolicyBusy}
        />
      )}
    </>
  );
}

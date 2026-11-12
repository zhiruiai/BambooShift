import { uiText } from '../../i18n';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AddAppConnection, ConnectedApp } from '../../../../shared/app-connections';
import { validAppAddress } from '../../appConnections';
import { providerForEndpoint } from '../../appProviders';
import { RemoteMcpImport } from './RemoteMcpImport';
import '../AppsDialog.css';
import type { useAppsDialogContent } from './useAppsDialogContent';
export type AppsDialogContentModel = ReturnType<typeof useAppsDialogContent>;
export function AddAppConnectionView({
  feedback,
  ...model
}: AppsDialogContentModel & { feedback: ReactNode }) {
  const {
    props,
    busy,
    navigate,
    uncertain,
    draft,
    customReview,
    setError,
    mutate,
    scope,
    setDraft,
  } = model;
  return (
    <form
      className="apps-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          (customReview && draft.url !== customReview.url) ||
          !draft.name.trim() ||
          !validAppAddress(draft.url.trim()) ||
          !draft.shared ||
          (draft.authType === 'bearer' && !draft.token.trim())
        ) {
          setError(uiText('apps:text_8f30dec48148'));
          return;
        }
        const body: AddAppConnection = {
          name: draft.name.trim(),
          url: draft.url.trim(),
          authType: draft.authType,
          shared: true,
          ...(draft.authType === 'bearer' ? { token: draft.token.trim() } : {}),
        };
        void mutate(
          () => scope.request<ConnectedApp>('/apps', 'POST', body),
          uiText('apps:text_d10e4d5f1bf0'),
        );
      }}
    >
      <div className="apps-scroll dialog-form">
        {feedback}
        {!customReview && props.canManage && (
          <RemoteMcpImport
            disabled={busy || uncertain}
            hasDraft={
              !!(
                draft.name ||
                draft.url ||
                draft.token ||
                draft.shared ||
                draft.authType !== 'none'
              )
            }
            onApply={({ name, url }) => {
              if (busy || uncertain || !props.canManage || !scope.current(scope.ticket())) return;
              const provider = providerForEndpoint(url);
              setDraft({
                name,
                url,
                authType: provider?.authType ?? 'none',
                token: '',
                shared: false,
              });
              setError('');
            }}
          />
        )}
        {customReview && <p className="field-help">{uiText('workspace:appProposalCustomForm')}</p>}
        <label>
          {uiText('apps:text_e4569e38b854')}
          <input
            required
            maxLength={80}
            value={draft.name}
            disabled={busy || !props.canManage}
            onChange={(event) =>
              setDraft({
                ...draft,
                name: event.target.value,
                ...(customReview ? { shared: false } : {}),
              })
            }
            placeholder={uiText('apps:text_53a346000dd9')}
          />
        </label>
        <label>
          {uiText('apps:text_02739d1bae8b')}
          <input
            required
            type="url"
            value={draft.url}
            readOnly={!!customReview}
            disabled={busy || !props.canManage}
            onChange={(event) => {
              if (!customReview)
                setDraft({ ...draft, url: event.target.value, token: '', shared: false });
            }}
            placeholder="https://example.com/mcp"
            autoComplete="off"
          />
        </label>
        <p className="field-help">{uiText('apps:text_bd512fb8685a')}</p>
        <label>
          {uiText('apps:text_d1ff8f98bc3f')}
          <select
            value={draft.authType}
            disabled={busy || !props.canManage}
            onChange={(event) =>
              setDraft({
                ...draft,
                authType: event.target.value as ConnectedApp['authType'],
                token: '',
                ...(customReview ? { shared: false } : {}),
              })
            }
          >
            <option value="none">{uiText('apps:text_41dda397a0fa')}</option>
            <option value="bearer">{uiText('apps:text_0614a644834f')}</option>
            <option value="oauth">{uiText('apps:text_af4ed0e21d61')}</option>
          </select>
        </label>
        {draft.authType === 'bearer' && (
          <label>
            {uiText('apps:text_81123c56d5d8')}
            <input
              type="password"
              required
              value={draft.token}
              disabled={busy || !props.canManage}
              autoComplete="new-password"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  token: event.target.value,
                  ...(customReview ? { shared: false } : {}),
                })
              }
              placeholder={uiText('apps:text_c98f6f352c4d')}
            />
            <span className="field-help">{uiText('apps:text_951456753e58')}</span>
          </label>
        )}
        <label className="apps-consent">
          <input
            type="checkbox"
            checked={draft.shared}
            disabled={busy || !props.canManage}
            onChange={(event) => setDraft({ ...draft, shared: event.target.checked })}
          />
          <span>
            {uiText('apps:text_3de51a26afc9')}
            {props.team ? uiText('apps:text_71a900056a0c') : uiText('apps:text_a52b1262d30b')}
            {uiText('apps:text_fcd1fefe9678')}
          </span>
        </label>
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => navigate('list')}
        >
          {uiText('apps:text_2cd0f3be8738')}
        </button>
        <button
          className="primary-button"
          disabled={busy || uncertain || !props.canManage || !draft.shared}
        >
          {busy && <Loader2 size={15} className="spin" />}
          {uiText('apps:text_b1bea2878095')}
        </button>
      </div>
    </form>
  );
}

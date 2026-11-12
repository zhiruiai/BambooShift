import { uiText } from '../../i18n';
import { ArrowRight, Loader2, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  AccountSession,
  InvitationPreview,
  WorkspaceSummary,
} from '../../../../shared/platform';
import '../Platform.css';
import { accountEntryPath, platformApi, platformTime, workspacePath } from '../platformApi';
import { AccountShell } from './AccountShell';
export function InvitationPage({ token }: { token: string }) {
  const [preview, setPreview] = useState<InvitationPreview | null>(null),
    [session, setSession] = useState<AccountSession | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sequence = useRef(0),
    submitting = useRef(false);
  const next = `/invite/${encodeURIComponent(token)}`;
  async function load() {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    setPreview(null);
    setSession(null);
    try {
      const [invitation, account] = await Promise.all([
        platformApi<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`),
        platformApi<AccountSession>('/account/session'),
      ]);
      if (request === sequence.current) {
        setPreview(invitation);
        setSession(account);
      }
    } catch (cause) {
      if (request === sequence.current) setError((cause as Error).message);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [token]);
  return (
    <AccountShell
      title={
        preview
          ? uiText('account:text_6154c2533d63', { value0: preview.workspaceName })
          : uiText('account:text_46292d8167d7')
      }
      subtitle={uiText('account:text_e6d837a34721')}
    >
      {loading ? (
        <div className="platform-loading">
          <Loader2 className="spin" size={20} />
          <p>{uiText('account:text_cb3c54c7dc6f')}</p>
        </div>
      ) : (
        <>
          {error && (
            <p className="platform-error" role="alert">
              {error}
            </p>
          )}
          {preview && (
            <div className="platform-invitation">
              <Users size={25} />
              <strong>{preview.workspaceName}</strong>
              <p>
                {uiText('account:text_df2642414cf0')}
                {platformTime(preview.expiresAt)}
              </p>
              <small>{uiText('account:text_e81c76bc3b0a')}</small>
            </div>
          )}
          {!preview ? (
            <button
              className="secondary-button platform-full-button"
              type="button"
              onClick={() => void load()}
            >
              {uiText('account:text_8cef1ba1a0ea')}
            </button>
          ) : !preview.available ? (
            <>
              <p className="platform-error">{uiText('account:text_8cda008a46c4')}</p>
              <a className="secondary-button platform-full-button" href="/login">
                {uiText('account:text_7c80ed75063a')}
              </a>
            </>
          ) : session?.authenticated ? (
            <>
              <p className="platform-help">
                {uiText('account:text_608d6f105272')}
                {session.user?.name}
                {uiText('common:punct_da047c04c9b5')}
                {session.user?.email}
                {uiText('account:text_7a6d39f5727a')}
              </p>
              <button
                className="primary-button platform-full-button"
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (submitting.current) return;
                  submitting.current = true;
                  setBusy(true);
                  setError('');
                  try {
                    const workspace = await platformApi<WorkspaceSummary>(
                      `/invitations/${encodeURIComponent(token)}/accept`,
                      'POST',
                    );
                    window.location.assign(workspacePath(workspace.id));
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    submitting.current = false;
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 size={16} className="spin" /> : <Users size={16} />}
                {busy ? uiText('account:text_56d3b7cbe694') : uiText('account:text_c2bfabb77e64')}
              </button>
              {!session.user?.localOnly && (
                <button
                  className="platform-text-button"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      await platformApi('/account/logout', 'POST');
                      window.location.assign(accountEntryPath('login', next));
                    } catch (cause) {
                      setError((cause as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {uiText('account:text_81ad47418686')}
                </button>
              )}
            </>
          ) : (
            <>
              <a
                className="primary-button platform-full-button"
                href={accountEntryPath('login', next)}
              >
                {uiText('account:text_ada60d090839')}
                <ArrowRight size={16} />
              </a>
              <a
                className="secondary-button platform-full-button"
                href={accountEntryPath('register', next)}
              >
                {uiText('account:text_89a242b6b434')}
              </a>
            </>
          )}
        </>
      )}
    </AccountShell>
  );
}

import { uiText } from '../../i18n';
import {
  ArrowLeft,
  Check,
  Copy,
  Link,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Dialog } from '../../components/UI';
import { AccountInitial, AccountMenu } from '../AccountAccess';
import '../BotTemplatePage.css';
import '../Platform.css';
import { platformApi, platformTime, workspacePath } from '../platformApi';
import { BotSharingPolicy } from './parts';
import { TeamSkillPublishingPolicy } from './TeamSkillPublishingPolicy';
import type { useTeamPage } from './useTeamPage';
export type TeamPageModel = ReturnType<typeof useTeamPage>;
export function TeamPageView(model: TeamPageModel) {
  const {
    generating,
    workspaceId,
    session,
    data,
    knownWorkspace,
    personal,
    owner,
    busy,
    loading,
    load,
    team,
    setName,
    setError,
    setDialog,
    error,
    notice,
    unsavedInvitation,
    generateInvitation,
    generated,
    visibleInvitation,
    setCopied,
    generatedId,
    copied,
    setGenerated,
    setNotice,
    dialog,
    work,
    name,
    currentWorkspace,
  } = model;
  return (
    <main className="platform-team-page">
      <header className="platform-team-header">
        <a
          className="platform-brand"
          href={generating ? undefined : workspacePath(workspaceId)}
          aria-disabled={generating}
        >
          <Avatar size={32} />
          <span>BambooShift</span>
        </a>
        {session && (
          <AccountMenu
            session={session}
            activeWorkspaceId={workspaceId}
            navigationDisabled={generating}
          />
        )}
      </header>
      <div className="platform-team-content">
        <a
          className="platform-back"
          href={generating ? undefined : workspacePath(workspaceId)}
          aria-disabled={generating}
        >
          <ArrowLeft size={15} />
          {uiText('account:text_0a7576b364ac')}
        </a>
        <div className="platform-page-heading">
          <div>
            <h1>
              {data?.workspace.name || knownWorkspace?.name || uiText('account:text_2e6bfec616ad')}
            </h1>
            <p>
              {personal
                ? uiText('account:text_c5b06d592e1c')
                : owner
                  ? uiText('account:text_2d875e38bfb9')
                  : uiText('account:text_e16b094d331a')}
            </p>
          </div>
          <div>
            {!personal && (
              <button
                className="secondary-button"
                type="button"
                disabled={busy || loading}
                onClick={() => void load()}
              >
                {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                {uiText('account:text_aee887434131')}
              </button>
            )}
            {owner && team && (
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!data) return;
                  setName(data.workspace.name);
                  setError('');
                  setDialog({ kind: 'rename' });
                }}
              >
                <Pencil size={14} />
                {uiText('account:text_88f4625eade2')}
              </button>
            )}
          </div>
        </div>
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="platform-notice" role="status">
            {notice}
          </p>
        )}
        {knownWorkspace?.role === 'owner' && session?.user && (
          <BotSharingPolicy
            key={`${session.user.id}:${workspaceId}`}
            workspaceId={workspaceId}
            userId={session.user.id}
            kind={knownWorkspace.kind}
          />
        )}
        {owner && team && session?.user && (
          <TeamSkillPublishingPolicy
            key={`${session.user.id}:${workspaceId}`}
            workspaceId={workspaceId}
            userId={session.user.id}
          />
        )}
        {personal ? (
          <p className="platform-notice">{uiText('account:text_31ab1a2d981c')}</p>
        ) : !data ? (
          <div className="platform-loading">
            {loading ? (
              <>
                <Loader2 className="spin" size={24} />
                <p>{uiText('account:text_a0ce5a06b70d')}</p>
              </>
            ) : (
              <p>{uiText('account:text_d411c94dc6ff')}</p>
            )}
          </div>
        ) : (
          <>
            {!team && <p className="platform-notice">{uiText('account:text_31ab1a2d981c')}</p>}
            <section className="platform-section">
              <div className="platform-section-heading">
                <div>
                  <h2>{uiText('account:text_6e6d6ddbb7c1')}</h2>
                  <p>
                    {data.members.length}
                    {uiText('account:text_adbe5bc3cc80')}{' '}
                    {owner
                      ? uiText('account:text_d73ef208a401')
                      : uiText('account:text_6719c269129f')}
                  </p>
                </div>
                <Users size={20} />
              </div>
              <div className="platform-member-list">
                {data.members.length ? (
                  data.members.map((member) => (
                    <div className="platform-member-row" key={member.userId}>
                      <AccountInitial name={member.name} />
                      <div className="platform-member-copy">
                        <strong>
                          {member.name}
                          {session?.user?.id === member.userId && (
                            <small className="platform-inline-label">
                              {uiText('account:text_a0c7716669b5')}
                            </small>
                          )}
                        </strong>
                        <small>{member.email}</small>
                        <small>
                          {uiText('account:text_35f33f4d3473')}
                          {platformTime(member.joinedAt)}
                          {member.status === 'suspended' && uiText('account:text_16905bfcd163')}
                        </small>
                      </div>
                      <span className="platform-badge">
                        {member.role === 'owner'
                          ? uiText('account:text_3a3912b23eeb')
                          : uiText('account:text_6e6d6ddbb7c1')}
                      </span>
                      {owner && team && member.role !== 'owner' && (
                        <button
                          className="platform-text-button is-danger"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setError('');
                            setDialog({ kind: 'member', member });
                          }}
                        >
                          {uiText('account:text_6135d4159e89')}
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="platform-empty">{uiText('account:text_3f9a5dff3a18')}</p>
                )}
              </div>
            </section>
            {owner && team && (
              <section className="platform-section">
                <div className="platform-section-heading">
                  <div>
                    <h2>{uiText('account:text_addfc25ab35b')}</h2>
                    <p>{uiText('account:text_6e104595bd1c')}</p>
                  </div>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={busy || unsavedInvitation}
                    title={unsavedInvitation ? uiText('account:text_b0a8f8b5ad31') : undefined}
                    onClick={() => void generateInvitation()}
                  >
                    {generating ? <Loader2 className="spin" size={15} /> : <Link size={15} />}
                    {generating
                      ? uiText('account:text_a8b8730c9611')
                      : uiText('account:text_bd85d0c0543f')}
                  </button>
                </div>
                {generated && visibleInvitation && (
                  <div className="platform-generated-link">
                    <label>
                      {uiText('account:text_620190bf5189')}
                      <input
                        readOnly
                        value={generated.url}
                        onFocus={(event) => event.currentTarget.select()}
                        onCopy={(event) => {
                          const input = event.currentTarget;
                          if (
                            input.selectionStart === 0 &&
                            input.selectionEnd === input.value.length
                          )
                            setCopied(true);
                        }}
                      />
                    </label>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        const id = generated.invitation.id;
                        try {
                          await navigator.clipboard.writeText(generated.url);
                          if (generatedId.current === id) setCopied(true);
                        } catch {
                          if (generatedId.current === id)
                            setError(uiText('account:text_24cc1a633bd1'));
                        }
                      }}
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied
                        ? uiText('account:text_8f6f8d979c98')
                        : uiText('account:text_8e86f9b1d54f')}
                    </button>
                    {!copied && (
                      <button
                        className="platform-text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setGenerated(null);
                          setCopied(false);
                          setNotice(uiText('account:text_e3948935cc1a'));
                        }}
                      >
                        {uiText('account:text_cbe185308ff6')}
                      </button>
                    )}
                    <small>
                      {uiText('account:text_df2642414cf0')}
                      {platformTime(visibleInvitation.expiresAt)}
                      {uiText('account:text_c81d44f444c1')}
                    </small>
                  </div>
                )}
                {data.invitations.length ? (
                  <div className="platform-invitation-list">
                    {data.invitations.map((invitation) => (
                      <div key={invitation.id} className="platform-invitation-row">
                        <div>
                          <strong>
                            {
                              {
                                pending: uiText('account:text_eaa0921ebafb'),
                                used: uiText('account:text_9845c165151d'),
                                revoked: uiText('account:text_fef96e34f77b'),
                                expired: uiText('account:text_2fe0e3339ac4'),
                              }[invitation.status]
                            }
                          </strong>
                          <small>
                            {uiText('account:text_bc9b8586a7b5')}
                            {platformTime(invitation.createdAt)}
                          </small>
                          <small>
                            {uiText('account:text_df2642414cf0')}
                            {platformTime(invitation.expiresAt)}
                          </small>
                        </div>
                        {invitation.status === 'pending' && (
                          <button
                            className="platform-text-button"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setError('');
                              setDialog({ kind: 'invitation', invitation });
                            }}
                          >
                            {uiText('account:text_30ce196a6100')}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="platform-empty">{uiText('account:text_d0c49dd769e8')}</p>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {dialog && data && (
        <Dialog
          title={
            dialog.kind === 'rename'
              ? uiText('account:text_f188ddb79252')
              : dialog.kind === 'member'
                ? uiText('account:text_023513878fc0')
                : uiText('account:text_949460c7182c')
          }
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          className="platform-dialog"
        >
          {dialog.kind === 'rename' ? (
            <form
              className="dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void work(async () => {
                  await platformApi(
                    `/account/workspaces/${encodeURIComponent(workspaceId)}`,
                    'PATCH',
                    { name: name.trim() },
                  );
                  if (currentWorkspace.current === workspaceId) setDialog(null);
                }, uiText('account:text_79e43be0b962'));
              }}
            >
              <label>
                {uiText('account:text_492fd0457fc4')}
                <input
                  required
                  maxLength={80}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {error && (
                <p className="platform-error" role="alert">
                  {error}
                </p>
              )}
              <div className="dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  {uiText('account:text_2cd0f3be8738')}
                </button>
                <button className="primary-button" disabled={busy || !name.trim()}>
                  {busy && <Loader2 size={14} className="spin" />}
                  {uiText('account:text_a759dd2529f1')}
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="platform-help">
                {dialog.kind === 'member'
                  ? uiText('account:text_2a408a507626', { value0: dialog.member.name })
                  : uiText('account:text_3607965799c9')}
              </p>
              {error && (
                <p className="platform-error" role="alert">
                  {error}
                </p>
              )}
              <div className="dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  {uiText('account:text_2cd0f3be8738')}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void work(
                      async () => {
                        const suffix =
                          dialog.kind === 'member'
                            ? `members/${encodeURIComponent(dialog.member.userId)}`
                            : `invitations/${encodeURIComponent(dialog.invitation.id)}`;
                        await platformApi(
                          `/account/workspaces/${encodeURIComponent(workspaceId)}/${suffix}`,
                          'DELETE',
                        );
                        if (currentWorkspace.current === workspaceId) setDialog(null);
                      },
                      dialog.kind === 'member'
                        ? uiText('account:text_47311bd899c4')
                        : uiText('account:text_6eb6328acd73'),
                    )
                  }
                >
                  {busy ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  {dialog.kind === 'member'
                    ? uiText('account:text_ee7dea070d88')
                    : uiText('account:text_8192e705f0b7')}
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </main>
  );
}

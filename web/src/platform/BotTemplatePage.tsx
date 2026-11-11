import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, RefreshCw } from 'lucide-react';
import type { AccountSession, WorkspaceSummary } from '../../../shared/platform';
import { botTemplatePath, type PublishedBotTemplate } from '../../../shared/bot-templates';
import { Avatar } from '../components/Avatar';
import { BotTemplatePreview, RoutineInstallChoice } from '../components/BotTemplatePreview';
import {
  createBotInstaller,
  createBotTemplateScope,
  type BotInstallerState,
  type RoutineInstallMode,
  type TemplateIdentity,
} from '../botTemplates';
import { AccountMenu } from './AccountAccess';
import { accountEntryPath, platformApi } from './platformApi';
import {
  createTemplatePageReader,
  templateImportTargets,
  type TemplatePageState,
} from './botTemplatePageState';
import './Platform.css';
import './BotTemplatePage.css';

export function BotTemplatePage({ token }: { token?: string }) {
  return token ? (
    <TemplatePage key={token} token={token} />
  ) : (
    <main className="loading-screen">
      <Avatar size={48} />
      <h1>{uiText('account:text_043f5451b142')}</h1>
      <p>{uiText('account:text_1bbb3fb5d5b1')}</p>
      <a href="/">{uiText('account:text_993fbcd2bb64')}</a>
    </main>
  );
}
function TemplatePage({ token }: { token: string }) {
  const path = botTemplatePath(token)!;
  const [state, setState] = useState<TemplatePageState>({ loading: true, error: '' });
  const [selection, setSelection] = useState<{ userId: string; id: string }>();
  const [previewMode, setPreviewMode] = useState<RoutineInstallMode>('pause');
  const [pendingRevision, setPendingRevision] = useState<string>();
  const [changingAccount, setChangingAccount] = useState(false);
  const pathname = useRef(window.location.pathname);
  const [reader] = useState(() =>
    createTemplatePageReader({
      token,
      current: () => window.location.pathname === pathname.current,
      onChange: setState,
    }),
  );
  const userId = state.session?.authenticated ? state.session.user?.id : undefined;
  const targets = templateImportTargets(state.session);
  const selected =
    selection && selection.userId === userId
      ? targets.find((item) => item.id === selection.id)
      : targets.find((item) => item.kind === 'personal') || targets[0];
  const identity = useRef<TemplateIdentity>({});
  identity.current = changingAccount ? {} : { userId, workspaceId: selected?.id };
  useEffect(() => {
    if (userId && selected && selection?.userId !== userId)
      setSelection({ userId, id: selected.id });
  }, [userId, selected?.id, selection?.userId]);
  useEffect(() => {
    reader.resume();
    void reader.read();
    const refresh = () => {
      if (!document.hidden) void reader.read();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('openbot:account-expired', refresh);
    window.addEventListener('openbot:revalidate', refresh);
    document.addEventListener('visibilitychange', refresh);
    const heartbeat = setInterval(refresh, 30_000);
    return () => {
      reader.suspend();
      clearInterval(heartbeat);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('openbot:account-expired', refresh);
      window.removeEventListener('openbot:revalidate', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reader]);
  return (
    <main className="platform-team-page template-public-page">
      <header className="platform-team-header">
        <a className="platform-brand" href="/">
          <Avatar size={32} />
          <span>BambooShift</span>
        </a>
        {state.session?.authenticated ? (
          <AccountMenu session={state.session} />
        ) : (
          <a className="secondary-button" href={accountEntryPath('login', path)}>
            {uiText('account:text_1e2df9c3075a')}
          </a>
        )}
      </header>
      <div className="template-public-content">
        <div className="platform-page-heading">
          <div>
            <span className="template-eyebrow">{uiText('account:text_b3e9706e0625')}</span>
            <h1>{uiText('account:text_960b994dce33')}</h1>
            <p>{uiText('account:text_ac111dcd0567')}</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={state.loading}
            onClick={() => void reader.read()}
          >
            {state.loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {uiText('account:text_df7392cc96be')}
          </button>
        </div>
        {state.error && (
          <div className="platform-error" role="alert">
            <p>{state.error}</p>
            <p>{uiText('account:text_5f9382cd4ecb')}</p>
            {state.session?.authenticated && (
              <button
                type="button"
                className="platform-text-button"
                disabled={changingAccount}
                onClick={async () => {
                  setChangingAccount(true);
                  reader.suspend();
                  identity.current = {};
                  try {
                    await platformApi('/account/logout', 'POST');
                    if (window.location.pathname === pathname.current)
                      window.location.assign(accountEntryPath('login', path));
                  } catch {
                    reader.resume();
                    void reader.read();
                    setChangingAccount(false);
                  }
                }}
              >
                {uiText('account:text_d7a03b5002ab')}
              </button>
            )}
          </div>
        )}
        {state.loading && (
          <p className="platform-help" role="status">
            {uiText('account:text_8ebc7b25445e')}
          </p>
        )}
        {(state.preview || state.session?.authenticated) && (
          <div className="template-public-layout">
            <div className="template-public-preview" hidden={state.loading}>
              {pendingRevision && state.preview && pendingRevision !== state.preview.revision ? (
                <p className="platform-notice">{uiText('account:text_23ba94c540f6')}</p>
              ) : state.preview ? (
                <>
                  <div className="template-public-label">
                    <span className="platform-badge">
                      {state.preview.audience === 'team'
                        ? uiText('account:text_02a6b4f28de4')
                        : uiText('account:text_2f96f8928991')}
                    </span>
                    <span>{uiText('account:text_62e853a067e8')}</span>
                  </div>
                  <BotTemplatePreview
                    blueprint={state.preview.blueprint}
                    avatarPath={state.preview.avatarPath}
                    userId={userId}
                    routineMode={previewMode}
                  />
                </>
              ) : (
                <p className="field-help">{uiText('account:text_3d1b48404844')}</p>
              )}
            </div>
            <aside className="template-public-import">
              {!state.session?.authenticated ? (
                <>
                  <h2>{uiText('account:text_3d5e974fc665')}</h2>
                  <p>{uiText('account:text_b1e9e97d3ab5')}</p>
                  <a
                    className="primary-button platform-full-button"
                    href={accountEntryPath('login', path)}
                  >
                    {uiText('account:text_42b334ff5e94')}
                    <ArrowRight size={15} />
                  </a>
                  <a
                    className="secondary-button platform-full-button"
                    href={accountEntryPath('register', path)}
                  >
                    {uiText('account:text_26ad87f000c9')}
                  </a>
                </>
              ) : !selected || !userId ? (
                <>
                  <h2>{uiText('account:text_dc47eea895aa')}</h2>
                  <p>{uiText('account:text_2ce71f4e2cc7')}</p>
                  {userId && targets.length > 0 && (
                    <label className="dialog-form">
                      {uiText('account:text_4377b79fc677')}
                      <select
                        value=""
                        onChange={(event) => setSelection({ userId, id: event.target.value })}
                      >
                        <option value="" disabled>
                          {uiText('account:text_26d2f7a67f71')}
                        </option>
                        {targets.map((workspace) => (
                          <option value={workspace.id} key={workspace.id}>
                            {workspace.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <a href="/">{uiText('account:text_45bf8c4e8be0')}</a>
                </>
              ) : (
                <TemplateImportForm
                  key={`${userId}:${selected.id}:${token}`}
                  session={state.session}
                  token={token}
                  target={selected}
                  targets={targets}
                  preview={state.preview}
                  disabled={state.loading || changingAccount}
                  identity={() => identity.current}
                  onTarget={(id) => setSelection({ userId, id })}
                  onMode={setPreviewMode}
                  onPendingRevision={setPendingRevision}
                />
              )}
            </aside>
          </div>
        )}
        {!state.preview && !state.loading && !state.session?.authenticated && (
          <div className="template-public-auth">
            <a className="primary-button" href={accountEntryPath('login', path)}>
              {uiText('account:text_aa0b485b6bd1')}
            </a>
            <a className="secondary-button" href={accountEntryPath('register', path)}>
              {uiText('account:text_679e917b16ef')}
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
function TemplateImportForm({
  session,
  token,
  target,
  targets,
  preview,
  disabled,
  identity,
  onTarget,
  onMode,
  onPendingRevision,
}: {
  session: AccountSession;
  token: string;
  target: WorkspaceSummary;
  targets: WorkspaceSummary[];
  preview?: PublishedBotTemplate;
  disabled: boolean;
  identity: () => TemplateIdentity;
  onTarget: (id: string) => void;
  onMode: (mode: RoutineInstallMode) => void;
  onPendingRevision: (revision?: string) => void;
}) {
  const userId = session.user!.id;
  const latest = useRef(identity);
  latest.current = identity;
  const [scope] = useState(() =>
    createBotTemplateScope({ userId, workspaceId: target.id, identity: () => latest.current() }),
  );
  const [state, setState] = useState<BotInstallerState>({ busy: false, checked: false, error: '' });
  const [installer] = useState(() =>
    createBotInstaller({
      scope,
      kind: 'import',
      storageKey: `openbot:template-import:${userId}:${target.id}:${token}`,
      onChange: setState,
    }),
  );
  const [name, setName] = useState(
      installer.state.attempt?.name ?? preview?.blueprint.profile.name ?? '',
    ),
    [routineMode, setRoutineMode] = useState<RoutineInstallMode>(
      installer.state.attempt?.routineMode ?? 'pause',
    );
  const initialized = useRef(!!preview || !!installer.state.attempt);
  useEffect(() => {
    if (preview && !initialized.current) {
      initialized.current = true;
      setName(preview.blueprint.profile.name);
    }
  }, [preview]);
  useEffect(() => {
    scope.resume();
    installer.resume();
    setState(installer.state);
    return () => {
      installer.suspend();
      scope.suspend();
    };
  }, [scope, installer]);
  const locked =
    disabled || !preview || state.busy || !!state.attempt || !!state.receipt || !!state.confirmed;
  const frozen = state.attempt?.kind === 'import' ? state.attempt : undefined;
  const changedVersion = !!frozen && !!preview && frozen.expectedRevision !== preview.revision;
  useEffect(() => {
    onPendingRevision(frozen?.expectedRevision);
  }, [frozen?.expectedRevision, onPendingRevision]);
  useEffect(() => {
    onMode(frozen?.routineMode ?? routineMode);
  }, [frozen?.routineMode, routineMode, onMode]);
  useEffect(() => {
    if (state.confirmed && !disabled && scope.current(scope.ticket()))
      window.location.assign(
        `/w/${target.id}?conversation=${encodeURIComponent(state.confirmed.conversation.id)}`,
      );
  }, [state.confirmed, disabled, scope, target.id]);
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!locked && preview && name.trim())
          void installer.start({
            kind: 'import',
            token,
            expectedRevision: preview.revision,
            name: name.trim(),
            routineMode,
          });
      }}
    >
      <h2>{uiText('account:text_3d5e974fc665')}</h2>
      <p className="field-help">
        {uiText('account:text_0f2ffdeb0496')}
        {session.user!.name}
      </p>
      <label>
        {uiText('account:text_6919eb274a2b')}
        <select
          value={target.id}
          disabled={state.busy}
          onChange={(event) => onTarget(event.target.value)}
        >
          {targets.map((workspace) => (
            <option value={workspace.id} key={workspace.id}>
              {workspace.name}
              {workspace.kind === 'personal'
                ? uiText('account:text_e7490e9aed0e')
                : uiText('account:text_dc8afa33a386')}
            </option>
          ))}
        </select>
      </label>
      <label>
        {uiText('account:text_194154ae5bca')}
        <input
          value={frozen?.name ?? name}
          disabled={locked}
          maxLength={40}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {changedVersion ? (
        <p className="platform-notice">
          {uiText('account:text_399e0774458f')}
          {frozen!.routineMode === 'pause'
            ? uiText('account:text_7ee8887b6b88')
            : uiText('account:text_f6b08e935c2a')}
          {uiText('account:text_6bd42041e7e9')}
        </p>
      ) : (
        <RoutineInstallChoice
          mode={frozen?.routineMode ?? routineMode}
          onChange={setRoutineMode}
          disabled={locked}
          routines={preview?.blueprint.routines || []}
        />
      )}
      {!changedVersion &&
        (frozen?.routineMode ?? routineMode) === 'preserve' &&
        preview?.blueprint.routines.some((routine) => routine.enabled) && (
          <p className="platform-notice">{uiText('account:text_6202fc7b4e23')}</p>
        )}
      {preview && !changedVersion && (
        <p className="field-help">
          {uiText('account:text_d3a7d8fee261')}
          {preview.blueprint.skills.length}
          {uiText('account:text_00fb2bb1c9d8')}
        </p>
      )}
      {state.error && (
        <p className="platform-error" role="alert">
          {state.error}
        </p>
      )}
      {state.confirmed ? (
        <>
          <p className="platform-notice" role="status">
            {uiText('account:text_99e672505549')}
            {target.name}
            {uiText('account:text_5fbaa005a3de')}
            {state.confirmed.agent.name}
            {uiText('common:punct_eb0d5884569b')}
          </p>
          <a
            className="primary-button platform-full-button"
            href={`/w/${target.id}?conversation=${encodeURIComponent(state.confirmed.conversation.id)}`}
          >
            {uiText('account:text_550cc20d011a')}
            <ArrowRight size={15} />
          </a>
        </>
      ) : state.attempt || state.receipt ? (
        <>
          <p className="field-help">{uiText('account:text_db7cac1c793c')}</p>
          <button
            className="secondary-button"
            type="button"
            disabled={disabled || state.busy}
            onClick={() => void installer.check()}
          >
            {state.busy && <Loader2 className="spin" size={15} />}
            {uiText('account:text_18226bf03e12')}
          </button>
          {state.checked && (
            <button
              className="primary-button"
              type="button"
              disabled={disabled || state.busy}
              onClick={() => void installer.retry()}
            >
              {uiText('account:text_3e47a416a946')}
            </button>
          )}
        </>
      ) : (
        <button className="primary-button" disabled={locked || !name.trim()}>
          {state.busy ? <Loader2 className="spin" size={15} /> : <ArrowRight size={15} />}
          {uiText('account:text_f23e7e58a29f')}
        </button>
      )}
    </form>
  );
}

import { uiText } from '../../i18n';
import { ArrowLeft, Copy, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BotBlueprint } from '../../../../shared/bot-blueprint';
import type {
  BotTemplate,
  TemplateAudience,
  TemplateSharingPolicy,
} from '../../../../shared/bot-templates';
import { cloneBlueprint, definiteTemplateRejection, type BotCopySource } from '../../botTemplates';
import { BotTemplateEditor, BotTemplatePreview } from '../BotTemplatePreview';
import '../BotTemplates.css';
import { Dialog } from '../UI';
import { Common, PendingEdit } from './types';
export function TemplateManager(props: Common & { templateId: string }) {
  const [record, setRecord] = useState<BotTemplate>(),
    [draft, setDraft] = useState<BotBlueprint>(),
    [policy, setPolicy] = useState<TemplateSharingPolicy>(),
    [audience, setAudience] = useState<TemplateAudience>(props.team ? 'team' : 'public'),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirm, setConfirm] = useState<'publish' | 'revoke' | 'refresh' | null>(null),
    [refreshSource, setRefreshSource] = useState<BotCopySource>(),
    [leave, setLeave] = useState<(() => void) | null>(null),
    [pending, setPending] = useState<PendingEdit | undefined>(() => {
      try {
        const value = JSON.parse(
          sessionStorage.getItem(
            `openbot-template-edit:${props.userId || 'local'}:${props.workspaceId || 'local'}:${props.templateId}`,
          ) || 'null',
        );
        const path = `/bot-templates/${encodeURIComponent(props.templateId)}`;
        return value &&
          ((value.method === 'PATCH' && value.path === path) ||
            (value.method === 'POST' &&
              ['publish', 'revoke', 'refresh', 'sync'].some(
                (action) => value.path === `${path}/${action}`,
              ))) &&
          value.body &&
          typeof value.body === 'object'
          ? value
          : undefined;
      } catch {
        return;
      }
    }),
    [checked, setChecked] = useState(false),
    [observed, setObserved] = useState<BotTemplate>();
  const pendingRef = useRef(pending);
  const storageKey = `openbot-template-edit:${props.userId || 'local'}:${props.workspaceId || 'local'}:${props.templateId}`;
  const running = useRef(false),
    active = useRef(true),
    sequence = useRef(0),
    root = `/bot-templates/${encodeURIComponent(props.templateId)}`;
  const current = () => active.current && props.scope.current(props.scope.ticket());
  const dirty = !!record && !!draft && JSON.stringify(record.blueprint) !== JSON.stringify(draft);
  function navigate(work: () => void) {
    if (!current() || running.current) return;
    if (dirty) setLeave(() => work);
    else work();
  }
  function accept(value: BotTemplate) {
    setRecord(value);
    setDraft(cloneBlueprint(value.blueprint));
    setEditing(false);
    setConfirm(null);
    setRefreshSource(undefined);
    pendingRef.current = undefined;
    setPending(undefined);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {}
    setChecked(false);
    setObserved(undefined);
  }
  async function read() {
    const order = ++sequence.current;
    if (!current() || running.current) return;
    setLoading(true);
    setError('');
    try {
      const [value, sharing] = await Promise.all([
        props.scope.request<BotTemplate>(root),
        props.scope.request<TemplateSharingPolicy>('/bot-sharing-policy'),
      ]);
      if (current() && order === sequence.current) {
        setPolicy(sharing);
        if (dirty || pendingRef.current) {
          if (!record) {
            setRecord(value);
            setDraft(
              cloneBlueprint(
                pendingRef.current?.method === 'PATCH' && pendingRef.current.body.blueprint
                  ? (pendingRef.current.body.blueprint as BotBlueprint)
                  : value.blueprint,
              ),
            );
          }
          setObserved(value);
          setChecked(true);
        } else accept(value);
      }
    } catch (cause) {
      if (current()) setError((cause as Error).message);
    } finally {
      if (current() && order === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void read();
    return () => {
      active.current = false;
      sequence.current++;
    };
  }, []);
  async function mutate(request: PendingEdit) {
    if (!current() || running.current || (pendingRef.current && pendingRef.current !== request))
      return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    pendingRef.current = request;
    setPending(request);
    setChecked(false);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      const value = await props.scope.request<BotTemplate>(
        request.path,
        request.method,
        request.body,
      );
      if (current()) {
        accept(value);
        props.onChanged();
        setNotice(uiText('common:text_1f5e95158d44'));
      }
    } catch (cause) {
      if (current()) {
        setError((cause as Error).message);
        if (definiteTemplateRejection(cause, 'template')) {
          pendingRef.current = undefined;
          setPending(undefined);
          sessionStorage.removeItem(storageKey);
          setObserved(undefined);
        }
      }
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  }
  async function prepareRefresh() {
    if (!current() || running.current || !record) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await props.scope.request<BotCopySource>(
        `/bot-copy-source/${encodeURIComponent(record.sourceAgentId)}`,
      );
      if (current()) {
        setRefreshSource(value);
        setConfirm('refresh');
      }
    } catch (cause) {
      if (current()) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  }
  const locked = busy || loading || !!pending,
    publication = record?.publication;
  return (
    <Dialog
      title={uiText('common:text_967239e43d73')}
      subtitle={uiText('common:text_18acafaeac00')}
      className="bot-template-dialog"
      onClose={() => navigate(props.onClose)}
    >
      <button
        type="button"
        className="platform-text-button"
        disabled={busy}
        onClick={() => navigate(props.onBack)}
      >
        <ArrowLeft size={14} />
        {uiText('common:text_afd8a25f3078')}
      </button>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="bot-form-notice" role="status">
          {notice}
        </p>
      )}
      {loading && !record && <p className="field-help">{uiText('common:text_c500eb769b5c')}</p>}
      {record && draft && (
        <>
          {publication ? (
            <div className="template-publication">
              <strong>
                {publication.audience === 'public'
                  ? uiText('common:text_54b0b5c4fd62')
                  : uiText('common:text_0708c4029244')}
              </strong>
              <p>
                {publication.audience === 'public'
                  ? uiText('common:text_1c5e851b2d0a')
                  : uiText('common:text_3cb67c98ce13')}{' '}
                {uiText('common:text_91df32fb83bd')}
              </p>
              <div className="template-link">
                <input
                  aria-label={uiText('common:text_80181508558c')}
                  readOnly
                  value={new URL(publication.path, window.location.origin).href}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        new URL(publication.path, window.location.origin).href,
                      );
                      if (current()) setNotice(uiText('common:text_729fa3cafb1f'));
                    } catch {
                      if (current()) setNotice(uiText('common:text_f711665e9a47'));
                    }
                  }}
                >
                  <Copy size={14} />
                  {uiText('common:text_8e86f9b1d54f')}
                </button>
              </div>
              {publication.digest !== record.draftDigest && (
                <p>{uiText('common:text_7b29bfb68f63')}</p>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={locked || !!confirm}
                onClick={() => setConfirm('revoke')}
              >
                {uiText('common:text_9938482fe281')}
              </button>
            </div>
          ) : (
            <p className="bot-form-notice">{uiText('common:text_bf08757473ed')}</p>
          )}
          <div className="template-toolbar">
            <button
              type="button"
              className="secondary-button"
              disabled={locked || !!confirm}
              onClick={() => setEditing(!editing)}
            >
              {editing ? uiText('common:text_b6c837a36a6e') : uiText('common:text_cc9752accb8b')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={locked || !!confirm}
              onClick={() => navigate(() => void prepareRefresh())}
            >
              {uiText('common:text_1dd518b11b3b')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void read()}
            >
              <RefreshCw size={14} />
              {uiText('common:text_90b0a90e2226')}
            </button>
          </div>
          {editing ? (
            <BotTemplateEditor value={draft} disabled={locked || !!confirm} onChange={setDraft} />
          ) : (
            <BotTemplatePreview
              workspaceId={props.workspaceId}
              userId={props.userId}
              blueprint={draft}
              avatarPath={record.avatarPath}
            />
          )}
          {dirty && (
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                disabled={
                  locked || !!confirm || !draft.profile.name.trim() || !draft.profile.role.trim()
                }
                onClick={() =>
                  void mutate({
                    method: 'PATCH',
                    path: root,
                    body: {
                      requestId: crypto.randomUUID(),
                      expectedRevision: record.revision,
                      expectedDraftRevision: record.draftRevision,
                      blueprint: draft,
                    },
                  })
                }
              >
                {uiText('common:text_e3440a041cb0')}
              </button>
            </div>
          )}
          {!dirty && (
            <div className="dialog-form">
              <label>
                {uiText('common:text_383803d9c71e')}
                <select
                  value={audience}
                  disabled={locked || !!confirm || policy?.mode === 'disabled'}
                  onChange={(event) => setAudience(event.target.value as TemplateAudience)}
                >
                  {props.team && <option value="team">{uiText('common:text_156bc368db28')}</option>}
                  <option value="public" disabled={policy?.mode !== 'public'}>
                    {uiText('common:text_ea8ca2a6b406')}
                  </option>
                </select>
              </label>
              <p className="field-help">
                {policy?.mode === 'disabled'
                  ? uiText('common:text_af19f5791fe3')
                  : policy?.mode === 'team-only'
                    ? uiText('common:text_40e1a987ea57')
                    : uiText('common:text_07005454ab83')}
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    locked ||
                    !policy ||
                    policy.mode === 'disabled' ||
                    (audience === 'public' && policy.mode !== 'public')
                  }
                  onClick={() => setConfirm('publish')}
                >
                  {publication
                    ? uiText('common:text_ee189c499565')
                    : uiText('common:text_cc6acee236a4')}
                </button>
              </div>
            </div>
          )}
          {record.projectionPending && (
            <div className="bot-form-notice">
              <p>{uiText('common:text_9e4fd7eedbf7')}</p>
              <button
                type="button"
                className="secondary-button"
                disabled={locked || !!confirm}
                onClick={() => void mutate({ method: 'POST', path: `${root}/sync`, body: {} })}
              >
                {uiText('common:text_0e4ab36d37ec')}
              </button>
            </div>
          )}
        </>
      )}
      {pending && (
        <div className="bot-form-notice">
          <p>{uiText('common:text_1ef70d95fc8f')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || loading}
            onClick={() => void read()}
          >
            {uiText('common:text_90b0a90e2226')}
          </button>
          {checked && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void mutate(pending)}
            >
              {uiText('common:text_23d944871e93')}
            </button>
          )}
        </div>
      )}
      {observed && !pending && (
        <div className="bot-form-notice">
          <p>{uiText('common:text_cd77e313dc6f')}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => navigate(() => accept(observed))}
          >
            {uiText('common:text_b24209588907')}
          </button>
        </div>
      )}
      {confirm && record && (
        <div className="template-confirm bot-form-notice" role="alert">
          {confirm === 'refresh' && refreshSource ? (
            <>
              <p>{uiText('common:text_013a4ded3147')}</p>
              <BotTemplatePreview
                workspaceId={props.workspaceId}
                userId={props.userId}
                blueprint={refreshSource.blueprint}
                avatarPath={refreshSource.avatarPath}
              />
            </>
          ) : (
            <p>
              {confirm === 'revoke'
                ? uiText('common:text_f6e2fad5e43d')
                : audience === 'public'
                  ? uiText('common:text_db0ec7ab9c3f')
                  : uiText('common:text_2eb383580e1c')}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              {uiText('common:text_2cd0f3be8738')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={locked}
              onClick={() => {
                const body = {
                  requestId: crypto.randomUUID(),
                  expectedRevision: record.revision,
                  ...(confirm === 'publish'
                    ? { expectedDraftRevision: record.draftRevision, audience }
                    : confirm === 'refresh' && refreshSource
                      ? { expectedSourceRevision: refreshSource.sourceRevision }
                      : {}),
                };
                void mutate({ method: 'POST', path: `${root}/${confirm}`, body });
              }}
            >
              {confirm === 'publish'
                ? uiText('common:text_c8f73143f3b8')
                : confirm === 'revoke'
                  ? uiText('common:text_8192e705f0b7')
                  : uiText('common:text_86fbfb624bd0')}
            </button>
          </div>
        </div>
      )}
      {leave && (
        <div className="bot-form-notice" role="alert">
          <p>{uiText('common:text_6276e1d8781c')}</p>
          <button type="button" className="secondary-button" onClick={() => setLeave(null)}>
            {uiText('common:text_fd4b9e3b6c68')}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              if (current() && !running.current) {
                const work = leave;
                setLeave(null);
                work();
              }
            }}
          >
            {uiText('common:text_fc0ee8283b68')}
          </button>
        </div>
      )}
      {!record && !loading && (
        <button type="button" className="secondary-button" onClick={() => void read()}>
          {uiText('common:text_df7392cc96be')}
        </button>
      )}
    </Dialog>
  );
}

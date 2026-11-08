import { uiText } from '../../i18n';
import { Check, Loader2, RefreshCw, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SharedBotSharingState, UpdateSharedBot } from '../../../../shared/shared-bots';
import { appSelections, sharedAppProblem } from '../../sharedBotApps';
import { sharedFileProblem } from '../../sharedBotFiles';
import {
  createSharedBotClient,
  sharingDraft,
  sharingNotApplied,
  sharingPath,
  sharingStorageKey,
  validSharingAttempt,
  type SharingAttempt,
} from '../../sharedBots';
import { SharedBotAppPicker } from '../SharedBotApps';
import { SharedBotFilePicker } from '../SharedBotFiles';
import '../SharedBots.css';
import { Dialog } from '../UI';
import { ManageProps } from './types';
export function ManageSharedBotDialog(props: ManageProps) {
  return (
    <ManageSharedBotContent
      key={`${props.userId}:${props.workspaceId}:${props.agentId}`}
      {...props}
    />
  );
}
export function ManageSharedBotContent(props: ManageProps) {
  const latest = useRef(props);
  latest.current = props;
  const [client] = useState(() =>
    createSharedBotClient({ userId: props.userId, identity: () => latest.current.userId }),
  );
  const [base, setBase] = useState<SharedBotSharingState>(),
    [draft, setDraft] = useState<ReturnType<typeof sharingDraft>>({
      targetTeamId: '',
      audience: 'team',
      memberIds: [],
      files: [],
      apps: [],
    });
  const [observed, setObserved] = useState<SharedBotSharingState>(),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [leave, setLeave] = useState(false),
    [revoke, setRevoke] = useState(false);
  const [storageError, setStorageError] = useState('');
  const storageBlocked = useRef(false);
  const [pending, setPending] = useState<SharingAttempt>();
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const running = useRef(false),
    baseline = useRef('');
  const selectingFiles = useRef(false),
    selectingApps = useRef(false);
  const [appsBusy, setAppsBusy] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const endpoint = sharingPath(props.workspaceId, props.agentId),
    storageKey = sharingStorageKey(props.userId, props.workspaceId, props.agentId);
  const dirty = !!baseline.current && JSON.stringify(draft) !== baseline.current;
  function accept(state: SharedBotSharingState) {
    const next = sharingDraft(state);
    setBase(state);
    setDraft(next);
    baseline.current = JSON.stringify(next);
    setObserved(undefined);
    setRevoke(false);
  }
  function persist(value?: SharingAttempt) {
    if (typeof sessionStorage === 'undefined') throw new Error(uiText('bots:text_aac7743a1d94'));
    value
      ? sessionStorage.setItem(storageKey, JSON.stringify(value))
      : sessionStorage.removeItem(storageKey);
    pendingRef.current = value;
    setPending(value);
  }
  async function read(initial = false) {
    const ticket = client.ticket();
    if (
      !client.current(ticket) ||
      running.current ||
      selectingFiles.current ||
      selectingApps.current
    )
      return;
    setLoading(true);
    setError('');
    try {
      const value = await client.request<SharedBotSharingState>(endpoint);
      if (!client.current(ticket)) return;
      if (initial || !base) accept(value);
      else setObserved(value);
    } catch (cause) {
      if (client.current(ticket)) setError((cause as Error).message);
    } finally {
      if (client.current(ticket)) setLoading(false);
    }
  }
  useEffect(() => {
    client.resume();
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const value = JSON.parse(saved);
        if (!validSharingAttempt(value)) throw new Error(uiText('bots:text_4691ae2aab9e'));
        pendingRef.current = value;
        setPending(value);
      }
    } catch (cause) {
      storageBlocked.current = true;
      setStorageError((cause as Error).message);
    }
    void read(true);
    return () => client.suspend();
  }, [client]);
  async function send(attempt: SharingAttempt) {
    const ticket = client.ticket();
    if (!client.current(ticket) || running.current || storageBlocked.current) return;
    running.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      persist(attempt);
      const state = await client.request<SharedBotSharingState>(
        endpoint + (attempt.method === 'POST' ? '/revoke' : ''),
        attempt.method,
        attempt.body,
      );
      if (!client.current(ticket)) return;
      persist(undefined);
      accept(state);
      setNotice(
        state.share?.status === 'active'
          ? uiText('bots:text_cf5fdf5b84b9')
          : uiText('bots:text_d2f0aa04fc4c'),
      );
      await latest.current.onChanged();
    } catch (cause) {
      if (!client.current(ticket)) return;
      if (sharingNotApplied(cause)) {
        persist(undefined);
        setObserved(undefined);
      }
      setError((cause as Error).message);
    } finally {
      running.current = false;
      if (client.current(ticket)) setSaving(false);
    }
  }
  function submit(isRevoke = false) {
    if (
      pendingRef.current ||
      selectingFiles.current ||
      selectingApps.current ||
      storageBlocked.current ||
      !base ||
      loading ||
      saving ||
      !client.current(client.ticket())
    )
      return;
    const team = base.teams.find((item) => item.id === draft.targetTeamId);
    const fileProblem =
      !isRevoke && (sharedFileProblem(draft.files) || sharedAppProblem(draft.apps));
    if (fileProblem) {
      setError(fileProblem);
      return;
    }
    if (
      !isRevoke &&
      (!team ||
        (draft.audience === 'selected' &&
          (!draft.memberIds.length ||
            draft.memberIds.some((id) => !team.members.some((member) => member.userId === id)))))
    ) {
      setError(uiText('bots:text_d977cd7a61a5'));
      return;
    }
    const body = isRevoke
      ? { requestId: crypto.randomUUID(), expectedRevision: base.share?.revision || 'unset' }
      : ({
          ...draft,
          files: draft.files.map(({ fileId, revision }) => ({ fileId, revision })),
          apps: appSelections(draft.apps),
          memberIds: draft.audience === 'team' ? [] : draft.memberIds,
          requestId: crypto.randomUUID(),
          expectedRevision: base.share?.revision || 'unset',
        } satisfies UpdateSharedBot);
    void send({ method: isRevoke ? 'POST' : 'PUT', body });
  }
  const team = base?.teams.find((item) => item.id === draft.targetTeamId),
    locked = loading || saving || !!pending || !!storageError;
  return (
    <Dialog
      title={uiText('bots:text_961209ad11a4', { value0: props.agentName })}
      subtitle={uiText('bots:text_edcc601c02a9')}
      className="shared-bots-dialog"
      onClose={() => {
        if (running.current || selectingFiles.current || selectingApps.current) return;
        if (dirty || pendingRef.current) setLeave(true);
        else props.onClose();
      }}
    >
      <div className="info-box">
        <Users size={17} />
        <span>{uiText('bots:text_2d72d5aa5dbb')}</span>
      </div>
      {props.workspaceKind === 'team' && (
        <p className="field-help">{uiText('bots:text_f39d1bd1b099')}</p>
      )}
      {storageError && (
        <p role="alert" className="error-text">
          {uiText('bots:text_1641c7953c94')}
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
          {uiText('bots:text_a51e5cd9712b')}
        </p>
      )}
      {notice && (
        <p role="status" className="field-help">
          {notice}
        </p>
      )}
      {leave && (
        <div className="shared-bot-recovery">
          <p>{pending ? uiText('bots:text_cf4c28dc5683') : uiText('bots:text_688eabe4d2ff')}</p>
          <button className="secondary-button" onClick={() => setLeave(false)}>
            {uiText('bots:text_5e6149034f06')}
          </button>
          <button className="secondary-button" onClick={props.onClose}>
            {pending ? uiText('bots:text_ae732511cb99') : uiText('bots:text_0711cc459572')}
          </button>
        </div>
      )}
      {pending && (
        <div className="shared-bot-recovery">
          <strong>{uiText('bots:text_fb7ec86bcd98')}</strong>
          <p>{uiText('bots:text_9e06ab95af84')}</p>
          {pending.method === 'PUT' && 'files' in pending.body && (
            <p>
              {uiText('bots:text_66d1b2013d47')}
              {pending.body.files?.length || 0} {uiText('bots:text_fba1600e7a22')}
            </p>
          )}
          {pending.method === 'PUT' && 'apps' in pending.body && (
            <p>
              {uiText('bots:text_66d1b2013d47')}
              {pending.body.apps?.length || 0} {uiText('bots:text_fffbb7b30391')}
            </p>
          )}
          <button
            disabled={saving || loading}
            className="secondary-button"
            onClick={() => void read()}
          >
            {uiText('bots:text_1ba48cafb80f')}
          </button>
          <button
            disabled={saving || loading}
            className="secondary-button"
            onClick={() => void send(pendingRef.current!)}
          >
            {uiText('bots:text_8d7d39d122a6')}
          </button>
        </div>
      )}
      {observed && (
        <div className="shared-bot-recovery">
          <p>
            {uiText('bots:text_40c1274a1ccc')}
            {observed.share?.status === 'active'
              ? uiText('bots:text_319b4992cdbd')
              : uiText('bots:text_3cd28d77c962')}{' '}
            ·{' '}
            {observed.teams.find((item) => item.id === observed.share?.targetTeamId)?.name ||
              uiText('bots:text_ab1a158f32c1')}{' '}
            ·{' '}
            {observed.share?.audience === 'selected'
              ? uiText('bots:text_427947234445')
              : uiText('bots:text_2e6bfec616ad')}
          </p>
          {!pending && (
            <button
              className="secondary-button"
              onClick={() => {
                accept(observed);
                setError('');
              }}
            >
              {uiText('bots:text_99a84ed6f45a')}
            </button>
          )}
        </div>
      )}
      {loading && !base ? (
        <p className="section-help">{uiText('bots:text_3d8bf8e2fe1f')}</p>
      ) : (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label>
            {uiText('bots:text_feab3c714639')}
            <select
              disabled={locked}
              value={draft.targetTeamId}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  targetTeamId: event.target.value,
                  memberIds: [],
                }))
              }
            >
              <option value="">{uiText('bots:text_e0a7a7c7745c')}</option>
              {base?.teams.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {!base?.teams.length && <p className="field-help">{uiText('bots:text_0cbb04f8bf2f')}</p>}
          <label>
            {uiText('bots:text_bd37181b53c2')}
            <select
              disabled={locked}
              value={draft.audience}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  audience: event.target.value as 'team' | 'selected',
                }))
              }
            >
              <option value="team">{uiText('bots:text_49b5ceb04f48')}</option>
              <option value="selected">{uiText('bots:text_85a8f63e03d9')}</option>
            </select>
          </label>
          {draft.audience === 'selected' && (
            <fieldset disabled={locked} className="shared-member-choices">
              <legend>{uiText('bots:text_45bf847b470d')}</legend>
              {team?.members.map((member) => (
                <label key={member.userId}>
                  <input
                    type="checkbox"
                    checked={draft.memberIds.includes(member.userId)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        memberIds: event.target.checked
                          ? [...current.memberIds, member.userId]
                          : current.memberIds.filter((id) => id !== member.userId),
                      }))
                    }
                  />
                  <span>{member.name}</span>
                </label>
              ))}
              {draft.memberIds.some(
                (id) => !team?.members.some((member) => member.userId === id),
              ) && <p className="error-text">{uiText('bots:text_306654963eb9')}</p>}
            </fieldset>
          )}
          <p className="field-help">
            {draft.audience === 'team'
              ? uiText('bots:text_fff018bff83c')
              : uiText('bots:text_ccb8539089c8')}
            {uiText('bots:text_6e6ffa54ec92')}
          </p>
          {base && !pending && (
            <SharedBotFilePicker
              client={client}
              userId={props.userId}
              endpoint={`${endpoint}/files`}
              files={draft.files}
              disabled={locked}
              onChange={(files) => setDraft((current) => ({ ...current, files }))}
              onBusy={(value) => {
                selectingFiles.current = value;
                setFilesBusy(value);
              }}
            />
          )}
          {base && !pending && (
            <SharedBotAppPicker
              client={client}
              endpoint={`${endpoint}/apps`}
              apps={draft.apps}
              disabled={locked}
              onChange={(apps) => setDraft((current) => ({ ...current, apps }))}
              onBusy={(value) => {
                selectingApps.current = value;
                setAppsBusy(value);
              }}
            />
          )}
          <div className="dialog-actions">
            <button
              className="primary-button"
              disabled={locked || filesBusy || appsBusy || !base?.teams.length}
            >
              {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              {uiText('bots:text_7d318ae37c87')}
            </button>
          </div>
        </form>
      )}
      {base?.share && (
        <section className="shared-bot-current">
          <strong>
            {base.share.status === 'active'
              ? uiText('bots:text_319b4992cdbd')
              : uiText('bots:text_8bff296ff202')}
          </strong>
          {base.share.status === 'active' && (
            <>
              <label>
                {uiText('bots:text_6503c9176aff')}
                <input
                  readOnly
                  value={`${typeof window === 'undefined' ? '' : window.location.origin}/shared-bots/${base.share.id}`}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
              <button
                type="button"
                className="text-button"
                disabled={locked}
                onClick={() => setRevoke(true)}
              >
                {uiText('bots:text_767b9fb8b1f6')}
              </button>
            </>
          )}
          {revoke && (
            <div className="shared-bot-recovery">
              <p>{uiText('bots:text_b94cbc124bd4')}</p>
              <button
                className="secondary-button"
                disabled={locked}
                onClick={() => setRevoke(false)}
              >
                {uiText('bots:text_f9926a5cdb51')}
              </button>
              <button className="primary-button" disabled={locked} onClick={() => submit(true)}>
                {uiText('bots:text_0562172ff8c5')}
              </button>
            </div>
          )}
        </section>
      )}
      {!pending && base && (
        <button
          type="button"
          className="text-button"
          disabled={saving || loading}
          onClick={() => void read()}
        >
          <RefreshCw size={14} />
          {uiText('bots:text_1ba48cafb80f')}
        </button>
      )}
    </Dialog>
  );
}

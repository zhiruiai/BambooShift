import { useEffect, useRef, useState } from 'react';
import { GraduationCap, Loader2 } from 'lucide-react';
import type { BotAgent, Skill } from '../../../shared/types';
import { isSharedBot } from '../../../shared/shared-bots';
import { useAccount } from '../AccountContext';
import { currentWorkspaceId } from '../workspace-scope';
import { createTeachingClient, type TeachingState } from '../teaching';
import { uiText } from '../i18n';
import { TeachingReview, teachingActionLabel } from './TeachingReview';
import { SkillsDialog } from './SkillsDialog';
import './TeachingPanel.css';
export function TeachingPanel(props: {
  agent?: BotAgent;
  conversationId: string;
  leaseId?: string;
  screenReady: boolean;
  busy: boolean;
  eligible?: boolean;
  binding?: string;
  onInputBlocked?: (blocked: boolean) => void;
  skills: Skill[];
  refresh: () => Promise<void>;
}) {
  const account = useAccount();
  if (
    !account ||
    account.workspace.role !== 'owner' ||
    !props.agent ||
    isSharedBot(props.agent) ||
    props.eligible === false
  )
    return null;
  return (
    <TeachingPanelOwned
      key={`${account.session.user?.id}:${account.workspace.id}:${props.agent.id}:${props.conversationId}`}
      {...props}
      agent={props.agent}
    />
  );
}
function TeachingPanelOwned({
  agent,
  conversationId,
  leaseId,
  screenReady,
  busy: outerBusy,
  skills,
  refresh,
  binding,
  onInputBlocked,
}: {
  agent: BotAgent;
  conversationId: string;
  leaseId?: string;
  screenReady: boolean;
  busy: boolean;
  binding?: string;
  onInputBlocked?: (blocked: boolean) => void;
  skills: Skill[];
  refresh: () => Promise<void>;
}) {
  const account = useAccount()!;
  const identity = useRef({ userId: account.session.user?.id, workspaceId: account.workspace.id });
  identity.current = { userId: account.session.user?.id, workspaceId: account.workspace.id };
  const currentBinding = useRef(binding);
  currentBinding.current = binding;
  const [state, setState] = useState<TeachingState>({
    busy: false,
    error: '',
    sessions: [],
    models: [],
  });
  const [client] = useState(() =>
    createTeachingClient({
      ...identity.current,
      agentId: agent.id,
      conversationId,
      identity: () => identity.current,
      locationWorkspace: currentWorkspaceId,
      binding: () => currentBinding.current,
      onState: (next) => {
        onInputBlocked?.(!!next.inputBlocked);
        setState(next);
      },
    }),
  );
  const [open, setOpen] = useState(false),
    [reviewingSkill, setReviewingSkill] = useState(false);
  useEffect(() => {
    client.resume();
    void client.check();
    return () => client.close();
  }, [client]);
  useEffect(() => client.bindingChanged(), [client, binding]);
  useEffect(() => {
    if (open) void client.check();
  }, [open, client]);
  useEffect(() => {
    if (!['recording', 'generating'].includes(state.session?.status || '')) return;
    const timer = setInterval(() => void client.check(), 1500);
    return () => clearInterval(timer);
  }, [open, state.session?.status, client]);
  useEffect(() => {
    if (state.session?.status === 'proposed') void refresh();
  }, [state.session?.skillId]);
  const session = state.session,
    locked = state.busy || outerBusy || !client.current();
  const statusKeys = {
    recording: 'teachingRecording',
    review: 'teachingReview',
    interrupted: 'teachingInterrupted',
    generating: 'teachingGenerating',
    proposed: 'teachingProposed',
    error: 'teachingError',
  } as const;
  const skill = skills.find((item) => item.id === session?.skillId);
  async function transition(id: string, action: string, expectedActiveId: string | null) {
    try {
      await client.skillRequest(`/skills/${encodeURIComponent(id)}/${action}`, {
        expectedActiveId,
      });
      await refresh();
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        error: (error as Error).message || uiText('workspace:teachingApproveError'),
      };
    }
  }
  return (
    <section className="teaching-panel">
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <GraduationCap size={16} />
        {uiText('workspace:teachingTitle')}
        {!open && session && ['recording', 'generating'].includes(session.status) && (
          <span className="teaching-live-status">
            {uiText(`workspace:${statusKeys[session.status]}`)}
          </span>
        )}
      </button>
      {open && (
        <div className="teaching-body">
          <p>{uiText('workspace:teachingIntro')}</p>
          <p className="section-help">{uiText('workspace:teachingPrivacy')}</p>
          <p className="section-help">{uiText('workspace:teachingLimit')}</p>
          {state.error && (
            <div role="alert" className="inline-save-error">
              {state.error}
            </div>
          )}
          {!!state.sessions.length && (
            <label>
              {uiText('workspace:teachingHistory')}
              <select
                disabled={
                  locked ||
                  state.uncertain ||
                  ['recording', 'generating'].includes(session?.status || '')
                }
                value={session?.id || ''}
                onChange={(event) => void client.select(event.target.value)}
              >
                <option value="">—</option>
                {state.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {new Date(s.createdAt).toLocaleString()} ·{' '}
                    {uiText(`workspace:${statusKeys[s.status]}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!session && !state.pendingId && (
            <>
              <p>{uiText('workspace:teachingReady')}</p>
              <button
                className="primary-button"
                disabled={
                  locked || !state.ready || !leaseId || !screenReady || agent.status === 'working'
                }
                onClick={() => void client.start(leaseId!)}
              >
                {uiText('workspace:teachingStart')}
              </button>
            </>
          )}
          {state.pendingId && (!session || state.uncertain) && (
            <div>
              <p>{uiText('workspace:teachingUnknown')}</p>
              <button
                className="secondary-button"
                disabled={locked}
                onClick={() => void client.cancel()}
              >
                {uiText('workspace:teachingCancel')}
              </button>
            </div>
          )}
          {session && (
            <>
              <div className="teaching-heading">
                <strong>{uiText(`workspace:${statusKeys[session.status]}`)}</strong>
                {state.busy && <Loader2 className="spin" size={16} />}
                <span>{uiText('workspace:teachingRecorded', { count: session.steps.length })}</span>
              </div>
              {session.status === 'recording' && (
                <>
                  <ol className="teaching-steps">
                    {session.steps.map((step) => (
                      <li key={step.id}>{teachingActionLabel(step.action)}</li>
                    ))}
                  </ol>
                  <button
                    className="primary-button"
                    disabled={locked || state.uncertain}
                    onClick={() => void client.stop()}
                  >
                    {uiText('workspace:teachingStop')}
                  </button>
                </>
              )}
              {['review', 'interrupted', 'error'].includes(session.status) && (
                <>
                  {session.status === 'error' && (
                    <p role="status">{uiText('workspace:teachingFailed')}</p>
                  )}
                  <TeachingReview
                    key={session.id}
                    session={session}
                    models={state.models}
                    busy={locked || !!state.uncertain}
                    onSave={async (body) =>
                      (await client.save(body)) ? client.state.session : undefined
                    }
                    onGenerate={(profile, partial, fingerprint) =>
                      client.generate(profile, partial, fingerprint)
                    }
                  />
                </>
              )}
              {session.status === 'generating' && (
                <button
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => void client.cancel()}
                >
                  {uiText('workspace:teachingCancel')}
                </button>
              )}
              {session.status === 'proposed' && (
                <>
                  <p>{uiText('workspace:teachingSaved')}</p>
                  {skill && <strong>{skill.name}</strong>}
                  <button
                    className="primary-button"
                    disabled={locked || !skill}
                    onClick={() => setReviewingSkill(true)}
                  >
                    {uiText('workspace:teachingReviewSkill')}
                  </button>
                </>
              )}
              {!['recording', 'generating'].includes(session.status) && (
                <button
                  className="text-button"
                  disabled={locked || state.uncertain}
                  onClick={() => client.newRecording()}
                >
                  {uiText('workspace:teachingNew')}
                </button>
              )}
            </>
          )}
          <button className="text-button" disabled={locked} onClick={() => void client.check()}>
            {uiText('workspace:teachingRefresh')}
          </button>
        </div>
      )}
      {reviewingSkill && (
        <SkillsDialog
          agents={[agent]}
          skills={skills.filter((s) => s.agentId === agent.id)}
          readOnly={false}
          busy={locked}
          onClose={() => setReviewingSkill(false)}
          onAdd={async (body) => {
            try {
              if (
                !body ||
                typeof body !== 'object' ||
                !('agentId' in body) ||
                body.agentId !== agent.id
              )
                throw Error(uiText('workspace:teachingApproveError'));
              await client.skillRequest('/skills', body);
              await refresh();
              return { ok: true as const };
            } catch (error) {
              return { ok: false as const, error: (error as Error).message };
            }
          }}
          onTransition={transition}
        />
      )}
    </section>
  );
}

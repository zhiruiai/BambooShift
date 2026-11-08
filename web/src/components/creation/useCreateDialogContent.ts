import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from '../../../../shared/group-members';
import { createAppConnectionScope } from '../../appConnections';
import { useAvatarEdits } from '../../avatarImages';
import { botProfileDraft, botProfileProblem, type BotProfileDraft } from '../../botProfiles';
import { useCreationRequests } from '../../creationRequests';
import '../BotProfiles.css';
import { suggestedGroupTitle } from '../GroupRecipients';
import { Props } from './parts';
export function useCreateDialogContent(props: Props) {
  const avatarEdits = useAvatarEdits();
  const [view, setView] = useState<'create' | 'model-settings' | 'starter-catalog'>('create');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [scope] = useState(() =>
    createAppConnectionScope({ ...props, identity: () => latest.current }),
  );
  const [choice, setChoice] = useState<'bot' | 'group' | 'team'>(
    props.botOnly
      ? 'bot'
      : props.canCreateBot
        ? props.initialPlanId
          ? 'team'
          : props.initialMode || 'bot'
        : 'group',
  );
  const [teamPlanId, setTeamPlanId] = useState(props.initialPlanId);
  const offeredPlan = useRef(props.initialPlanId);
  const [draft, setDraft] = useState(() =>
      props.initialProfile ? structuredClone(props.initialProfile) : botProfileDraft(),
    ),
    [title, setTitle] = useState(''),
    [customTitle, setCustomTitle] = useState(false),
    [ids, setIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [teamBusy, setTeamBusy] = useState(false),
    [leave, setLeave] = useState<(() => void) | null>(null);
  const running = useRef(false),
    teamLock = useRef(false),
    teamDirty = useRef(false),
    latest = useRef(props);
  latest.current = props;
  const creation = useCreationRequests({
    workspaceId: props.workspaceId,
    userId: props.userId,
  });
  const manual = useRef({ title, customTitle, ids });
  manual.current = { title, customTitle, ids };
  const groupTitle = customTitle ? title : suggestedGroupTitle(ids, props.agents);
  const mode = props.botOnly ? 'bot' : props.canCreateBot ? choice : 'group',
    locked = saving || teamBusy || creation.state.busy,
    manualLocked = locked || !!creation.state.request || !!creation.state.blocked;
  const dirty =
    mode === 'team'
      ? teamDirty.current
      : mode === 'group'
        ? !!title || !!ids.length
        : avatarEdits.pending || JSON.stringify(draft) !== JSON.stringify(botProfileDraft());
  useEffect(() => {
    scope.resume();
    return () => scope.suspend();
  }, [scope]);
  function navigate(work: () => void) {
    if (
      !scope.current(scope.ticket()) ||
      running.current ||
      teamLock.current ||
      creation.getState().busy ||
      avatarEdits.current().busy
    )
      return;
    if (
      mode === 'team'
        ? teamDirty.current
        : creation.getState().receipt
          ? false
          : mode === 'group'
            ? !!manual.current.title || !!manual.current.ids.length
            : dirty || avatarEdits.current().pending || avatarEdits.current().changed
    )
      setLeave(() => work);
    else work();
  }
  useEffect(() => {
    const id = props.initialPlanId;
    if (
      !id ||
      props.botOnly ||
      !props.canCreateBot ||
      id === offeredPlan.current ||
      running.current ||
      teamLock.current ||
      creation.getState().request
    )
      return;
    offeredPlan.current = id;
    navigate(() => {
      setTeamPlanId(id);
      setChoice('team');
      setError('');
    });
  }, [props.initialPlanId, props.canCreateBot, locked, creation.state.request]);
  async function create() {
    const ticket = scope.ticket();
    if (
      !scope.current(ticket) ||
      viewRef.current !== 'create' ||
      running.current ||
      creation.getState().busy ||
      creation.getState().request ||
      creation.getState().blocked ||
      mode === 'team' ||
      (mode === 'bot' && !latest.current.canCreateBot)
    )
      return;
    if (avatarEdits.current().pending) {
      setError(uiText('bots:text_865a354e722e'));
      return;
    }
    const selectedIds = manual.current.ids;
    const selectedTitle = manual.current.customTitle
      ? manual.current.title
      : suggestedGroupTitle(selectedIds, latest.current.agents);
    const problem =
      mode === 'bot'
        ? botProfileProblem(draft)
        : !selectedTitle.trim() ||
            selectedTitle.length > 100 ||
            /[\x00-\x1f\x7f\u2028\u2029]/.test(selectedTitle) ||
            selectedIds.length < GROUP_MIN_MEMBERS ||
            selectedIds.length > GROUP_MAX_MEMBERS ||
            new Set(selectedIds).size !== selectedIds.length ||
            selectedIds.some((id) => !latest.current.agents.some((agent) => agent.id === id))
          ? uiText('bots:text_d2b178492a53', {
              value0: GROUP_MIN_MEMBERS,
              value1: GROUP_MAX_MEMBERS,
            })
          : '';
    if (problem) {
      setError(problem);
      return;
    }
    running.current = true;
    setSaving(true);
    setError('');
    try {
      if (mode === 'group')
        await creation.createGroup({
          title: selectedTitle.trim(),
          agentIds: selectedIds,
        });
      else await creation.createBot(draft);
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }
  function canEditManual() {
    const state = creation.getState();
    return (
      scope.current(scope.ticket()) &&
      !running.current &&
      !state.busy &&
      !state.request &&
      !state.blocked
    );
  }
  function browseStarters() {
    if (
      mode === 'bot' &&
      latest.current.canCreateBot &&
      canEditManual() &&
      !avatarEdits.current().busy
    )
      setView('starter-catalog');
  }
  function chooseStarter(profile: BotProfileDraft) {
    if (!latest.current.canCreateBot || !canEditManual()) return;
    setView('create');
    navigate(() => {
      if (!latest.current.canCreateBot || !canEditManual()) return;
      avatarEdits.reset();
      setDraft(structuredClone(profile));
      setError('');
    });
  }
  function resetManualDraft() {
    avatarEdits.reset();
    setDraft(botProfileDraft());
    setTitle('');
    setCustomTitle(false);
    setIds([]);
    manual.current = { title: '', customTitle: false, ids: [] };
    setError('');
  }
  async function openCreated() {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || running.current || creation.getState().busy) return;
    running.current = true;
    setSaving(true);
    setError('');
    try {
      const receipt = await creation.check();
      if (!scope.current(ticket) || receipt?.status !== 'created' || !receipt.conversation) return;
      const opened = latest.current.onCreated(receipt.conversation, receipt.agents);
      if (opened && typeof opened.then === 'function') await opened;
      if (scope.current(ticket)) creation.finish();
    } catch {
      if (scope.current(ticket)) setError(uiText('bots:text_6b35398f4f31'));
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }

  return {
    view,
    browseStarters,
    chooseStarter,
    props,
    mode,
    navigate,
    locked,
    creation,
    setChoice,
    setTeamPlanId,
    resetManualDraft,
    leave,
    setLeave,
    running,
    teamLock,
    scope,
    error,
    openCreated,
    saving,
    latest,
    setView,
    teamPlanId,
    setTeamBusy,
    teamDirty,
    create,
    avatarEdits,
    draft,
    canEditManual,
    setDraft,
    manualLocked,
    ids,
    manual,
    setIds,
    groupTitle,
    setCustomTitle,
    setTitle,
    customTitle,
  };
}

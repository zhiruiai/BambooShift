import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { PrimaryBotState, UpdatePrimaryBot } from '../../../../shared/primary-bot';
import { isSharedBot } from '../../../../shared/shared-bots';
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from '../../../../shared/time-zone';
import type { Bootstrap } from '../../../../shared/types';
import { ApiError } from '../../api';
import { useAvatarEdits } from '../../avatarImages';
import { botProfileDraft, botProfileProblem } from '../../botProfiles';
import { confirmedPrimary, createPrimaryBotScope } from '../../primaryBot';
import '../PrimaryBot.css';
import { PrimaryBotMode, Props } from './parts';
export function usePrimaryBotContent(props: Props) {
  const avatarEdits = useAvatarEdits();
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createPrimaryBotScope({ ...props, identity: () => latest.current }),
  );
  const [base, setBase] = useState(props.state),
    [observed, setObserved] = useState<PrimaryBotState>();
  const [mode, setMode] = useState<PrimaryBotMode>(
    props.initialMode || (props.state?.agentId ? 'select' : 'create'),
  );
  const [agentId, setAgentId] = useState(props.state?.agentId || ''),
    [draft, setDraft] = useState(botProfileDraft);
  function checkInDraft(value?: PrimaryBotState) {
    return {
      ...(value?.checkIn || { enabled: true, time: '09:00' }),
      timeZone:
        value?.checkIn.timeZone ??
        (value?.agentId ? DEFAULT_TIME_ZONE : latest.current.defaultTimeZone || DEFAULT_TIME_ZONE),
    };
  }
  const [checkIn, setCheckIn] = useState(() => checkInDraft(props.state));
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [review, setReview] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirmClear, setConfirmClear] = useState(false),
    [leave, setLeave] = useState<(() => void) | null>(null);
  const running = useRef(false),
    baseline = useRef('');
  const currentForm = JSON.stringify({ mode, agentId, draft, checkIn });
  if (!baseline.current) baseline.current = currentForm;
  const dirty = avatarEdits.pending || currentForm !== baseline.current,
    locked = loading || saving;
  const available = !props.team && !!base?.available;
  function accept(value: PrimaryBotState, initial = false) {
    avatarEdits.reset();
    const nextMode =
      initial && props.initialMode ? props.initialMode : value.agentId ? 'select' : 'create';
    const nextDraft = botProfileDraft();
    setBase(value);
    setAgentId(value.agentId || '');
    const nextCheckIn = checkInDraft(value);
    setCheckIn(nextCheckIn);
    setDraft(nextDraft);
    setMode(nextMode);
    baseline.current = JSON.stringify({
      mode: nextMode,
      agentId: value.agentId || '',
      draft: nextDraft,
      checkIn: nextCheckIn,
    });
    setReview(false);
    setObserved(undefined);
    setError('');
    setNotice('');
    setConfirmClear(false);
  }
  useEffect(() => {
    scope.resume();
    const ticket = scope.ticket();
    void scope
      .request<PrimaryBotState>('/primary-bot')
      .then((value) => {
        if (scope.current(ticket)) accept(value, true);
      })
      .catch((cause) => {
        if (scope.current(ticket)) setError((cause as Error).message);
      })
      .finally(() => {
        if (scope.current(ticket)) setLoading(false);
      });
    return () => scope.suspend();
  }, [scope]);
  function navigate(work: () => void) {
    if (!scope.current(scope.ticket()) || running.current || avatarEdits.current().busy) return;
    if (dirty || avatarEdits.current().pending || avatarEdits.current().changed)
      setLeave(() => work);
    else work();
  }
  async function readCurrent() {
    if (!scope.current(scope.ticket()) || running.current) return;
    const ticket = scope.ticket();
    running.current = true;
    setSaving(true);
    setError('');
    try {
      const value = await scope.request<PrimaryBotState>('/primary-bot');
      if (!scope.current(ticket)) return;
      if (!base) accept(value, true);
      else {
        setObserved(value);
        setReview(true);
      }
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }
  async function openCurrent(value: PrimaryBotState) {
    if (!scope.current(scope.ticket()) || running.current) return;
    const ticket = scope.ticket();
    running.current = true;
    setSaving(true);
    setError('');
    try {
      const snapshot = await scope.request<Bootstrap>('/bootstrap');
      if (scope.current(ticket)) latest.current.onSaved(value, confirmedPrimary(snapshot, value));
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }
  async function save(clear = false) {
    const ticket = scope.ticket();
    if (
      !scope.current(ticket) ||
      running.current ||
      locked ||
      review ||
      !base?.available ||
      latest.current.team
    )
      return;
    if (avatarEdits.current().pending) {
      setError(uiText('bots:text_865a354e722e'));
      return;
    }
    const problem = clear
      ? ''
      : !/^([01]\d|2[0-3]):[0-5]\d$/.test(checkIn.time)
        ? uiText('bots:text_509cae761656')
        : mode === 'create'
          ? botProfileProblem(draft)
          : !latest.current.agents.some((agent) => agent.id === agentId && !isSharedBot(agent))
            ? uiText('bots:text_40451dd72adc')
            : '';
    if (problem) {
      setError(problem);
      return;
    }
    let selectedCheckIn = checkIn;
    if (!clear) {
      try {
        selectedCheckIn = { ...checkIn, timeZone: normalizeTimeZone(checkIn.timeZone) };
      } catch (cause) {
        setError((cause as Error).message);
        return;
      }
    }
    const body: UpdatePrimaryBot = clear
      ? { mode: 'clear', expectedRevision: base.revision }
      : mode === 'create'
        ? { mode, bot: draft, checkIn: selectedCheckIn, expectedRevision: base.revision }
        : { mode, agentId, checkIn: selectedCheckIn, expectedRevision: base.revision };
    running.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    let written = false;
    try {
      const value = await scope.request<PrimaryBotState>('/primary-bot', 'PUT', body);
      if (!scope.current(ticket)) return;
      written = true;
      setObserved(value);
      setReview(true);
      if (clear) {
        latest.current.onSaved(value);
        return;
      }
      const snapshot = await scope.request<Bootstrap>('/bootstrap');
      if (scope.current(ticket)) latest.current.onSaved(value, confirmedPrimary(snapshot, value));
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError((cause as Error).message);
      if (written) {
        setReview(true);
        setNotice(uiText('bots:text_2b78f4d9d6da'));
      } else if (
        !(cause instanceof ApiError) ||
        cause.status === 0 ||
        cause.status === 408 ||
        cause.status >= 500 ||
        cause.status === 409
      ) {
        setReview(true);
        setNotice(
          cause instanceof ApiError && cause.status === 409
            ? uiText('bots:text_d96574587d89')
            : uiText('bots:text_47b51ec4484e'),
        );
      }
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }

  return {
    navigate,
    props,
    loading,
    base,
    available,
    mode,
    locked,
    review,
    avatarEdits,
    setMode,
    save,
    agentId,
    setAgentId,
    draft,
    setDraft,
    checkIn,
    setCheckIn,
    scope,
    running,
    saving,
    confirmClear,
    setConfirmClear,
    error,
    notice,
    readCurrent,
    observed,
    openCurrent,
    accept,
    leave,
    setLeave,
  };
}

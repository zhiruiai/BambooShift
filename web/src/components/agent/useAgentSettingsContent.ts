import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { isSharedBot } from '../../../../shared/shared-bots';
import type { Bootstrap, BotAgent } from '../../../../shared/types';
import { ApiError } from '../../api';
import { createAppConnectionScope } from '../../appConnections';
import { useAvatarEdits } from '../../avatarImages';
import { botProfileDraft, botProfileProblem } from '../../botProfiles';
import '../BotProfiles.css';
import { Props } from './parts';
export function useAgentSettingsContent(props: Props & { boundScreen: boolean }) {
  props = { ...props, readOnly: props.readOnly || isSharedBot(props.agent) };
  const avatarEdits = useAvatarEdits();
  const [scope] = useState(() =>
    createAppConnectionScope({ ...props, identity: () => latest.current }),
  );
  const [base, setBase] = useState(props.agent),
    [draft, setDraft] = useState(() => botProfileDraft(props.agent));
  const [tab, setTab] = useState<'profile' | 'instructions' | 'related'>('profile');
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [conflict, setConflict] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const running = useRef(false),
    latest = useRef(props);
  latest.current = props;
  const dirty =
    avatarEdits.pending || JSON.stringify(draft) !== JSON.stringify(botProfileDraft(base));
  const locked = props.busy || saving;
  useEffect(() => {
    scope.resume();
    return () => scope.suspend();
  }, [scope]);
  const current = () => scope.current(scope.ticket());
  function navigate(work: () => void) {
    if (!current() || running.current || latest.current.busy || avatarEdits.current().busy) return;
    if (dirty || avatarEdits.current().pending || avatarEdits.current().changed)
      setLeave(() => work);
    else work();
  }
  function openExistingConversation() {
    if (!latest.current.onOpenConversation || latest.current.conversationAvailable === false)
      return;
    navigate(() => {
      if (latest.current.conversationAvailable !== false) latest.current.onOpenConversation?.();
    });
  }
  async function save() {
    if (!current() || running.current || latest.current.busy || latest.current.readOnly) return;
    if (avatarEdits.current().pending) {
      setError(uiText('settings:text_865a354e722e'));
      return;
    }
    const problem = botProfileProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    if (!base.configRevision) {
      setError(uiText('settings:text_49743817f439'));
      setConflict(true);
      return;
    }
    const ticket = scope.ticket();
    running.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const agent = await scope.request<BotAgent>(
        `/agents/${encodeURIComponent(base.id)}`,
        'PATCH',
        { ...draft, expectedRevision: base.configRevision },
      );
      if (!scope.current(ticket)) return;
      setBase(agent);
      setDraft(botProfileDraft(agent));
      setConflict(false);
      setNotice(uiText('settings:text_e8b59a3be25f'));
      avatarEdits.reset();
      latest.current.onSaved(agent);
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError((cause as Error).message);
      if (
        cause instanceof ApiError &&
        (cause.status === 409 || cause.status === 0 || cause.status >= 500)
      )
        setConflict(true);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }
  async function loadLatest() {
    if (!current() || running.current) return;
    const ticket = scope.ticket();
    running.current = true;
    setSaving(true);
    setError('');
    try {
      const value = await scope.request<Bootstrap>('/bootstrap'),
        agent = value.agents.find((item) => item.id === base.id);
      if (!scope.current(ticket)) return;
      if (!agent) throw new Error(uiText('settings:text_6e2b35ddfe5f'));
      setBase(agent);
      setDraft(botProfileDraft(agent));
      setConflict(false);
      setNotice(uiText('settings:text_72a41e4bbcb0'));
      avatarEdits.reset();
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }
  async function remove() {
    if (
      !current() ||
      running.current ||
      latest.current.busy ||
      latest.current.readOnly ||
      latest.current.deleteBlocked ||
      !confirmDelete
    )
      return;
    const ticket = scope.ticket();
    running.current = true;
    setSaving(true);
    setError('');
    try {
      await scope.request(`/agents/${encodeURIComponent(base.id)}`, 'DELETE');
      if (scope.current(ticket)) latest.current.onDeleted();
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }

  return {
    props,
    navigate,
    draft,
    locked,
    avatarEdits,
    openExistingConversation,
    tab,
    setTab,
    error,
    notice,
    conflict,
    base,
    loadLatest,
    leave,
    setLeave,
    running,
    current,
    save,
    setDraft,
    dirty,
    saving,
    latest,
    confirmDelete,
    setConfirmDelete,
    remove,
  };
}

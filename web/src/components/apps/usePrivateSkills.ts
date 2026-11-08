import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import type { createAppConnectionScope } from '../../appConnections';
import { uiText } from '../../i18n';
import {
  parsePrivateSkillShelf,
  privateSkillTargets,
  type PrivateSkillShelf,
} from '../../privateSkills';

type Selection = { id: string; revision: string; targetId: string };
type Mutation = { selection: Selection; enabled: boolean };
type Feedback = { kind: 'error' | 'status'; text: string };
type Phase = 'read' | 'write' | 'idle';
const empty: PrivateSkillShelf = { agents: [], skills: [] };

function currentSelection(shelf: PrivateSkillShelf, selection: Selection | null) {
  if (!selection) return null;
  const skill = shelf.skills.find(
    (row) => row.id === selection.id && row.revision === selection.revision,
  );
  if (!skill) return null;
  return {
    ...selection,
    targetId: privateSkillTargets(shelf, skill).some((agent) => agent.id === selection.targetId)
      ? selection.targetId
      : '',
  };
}

export function usePrivateSkills(
  scope: ReturnType<typeof createAppConnectionScope>,
  onBusyChange: (busy: boolean) => void,
  onChanged?: () => void,
  isPublishing?: () => boolean,
) {
  const [shelf, setShelf] = useState<PrivateSkillShelf>(empty);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [phase, setPhase] = useState<Phase>('read');
  const [feedback, setFeedback] = useState<Feedback>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const active = useRef(false);
  const sequence = useRef(0);
  const data = useRef(empty);
  const authoritative = useRef(false);
  const chosen = useRef<Selection | null>(null);
  const busy = useRef<Phase>('idle');
  const unresolved = useRef<Mutation | null>(null);

  function select(next: Selection | null) {
    chosen.current = next;
    setSelection(next);
  }
  function choose(next: Selection | null) {
    if (
      !active.current ||
      !scope.current(scope.ticket()) ||
      isPublishing?.() ||
      busy.current !== 'idle'
    )
      return;
    select(currentSelection(data.current, next));
    if (authoritative.current && !unresolved.current) setFeedback(undefined);
  }
  function begin(operation: Phase) {
    const ticket = scope.ticket();
    if (!active.current || !scope.current(ticket) || isPublishing?.() || busy.current !== 'idle')
      return;
    const generation = ++sequence.current;
    busy.current = operation;
    setPhase(operation);
    return () => active.current && sequence.current === generation && scope.current(ticket);
  }
  function finish(current: () => boolean) {
    if (!current()) return;
    if (busy.current === 'write') onBusyChange(false);
    busy.current = 'idle';
    setPhase('idle');
  }
  async function read(current: () => boolean) {
    const parsed = parsePrivateSkillShelf(await scope.request('/private-skills'));
    if (!current()) return;
    if (!parsed) throw new Error(uiText('apps:privateSkillsInvalid'));
    data.current = parsed;
    authoritative.current = true;
    setUnconfirmed(false);
    setShelf(parsed);
    select(currentSelection(parsed, chosen.current));
    return parsed;
  }
  function reconcile(result: PrivateSkillShelf, mutation: Mutation) {
    const { selection: intent, enabled } = mutation;
    const row = result.skills.find(
      (skill) => skill.id === intent.id && skill.revision === intent.revision,
    );
    const confirmed = (row?.enabledAgentIds.includes(intent.targetId) ?? false) === enabled;
    unresolved.current = null;
    setUnconfirmed(false);
    setFeedback(
      confirmed
        ? {
            kind: 'status',
            text: uiText(enabled ? 'apps:privateSkillEnabled' : 'apps:privateSkillDisabled'),
          }
        : { kind: 'error', text: uiText('apps:privateSkillCurrentState') },
    );
    if (confirmed) onChanged?.();
  }
  async function refresh() {
    const current = begin('read');
    if (!current) return;
    setFeedback(undefined);
    try {
      const result = await read(current);
      if (result && unresolved.current) reconcile(result, unresolved.current);
    } catch (cause) {
      if (current())
        setFeedback({
          kind: 'error',
          text: unresolved.current
            ? uiText('apps:privateSkillUnconfirmed')
            : cause instanceof Error
              ? cause.message
              : uiText('apps:privateSkillsInvalid'),
        });
    } finally {
      finish(current);
    }
  }
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      sequence.current++;
      if (busy.current === 'write') onBusyChange(false);
      busy.current = 'idle';
    };
  }, [scope]);

  async function update(intent: Selection, enabled: boolean) {
    const selected = chosen.current;
    if (
      !authoritative.current ||
      unresolved.current ||
      !selected ||
      selected.id !== intent.id ||
      selected.revision !== intent.revision ||
      selected.targetId !== intent.targetId ||
      !intent.targetId
    )
      return;
    const live = data.current.skills.find(
      (skill) => skill.id === intent.id && skill.revision === intent.revision,
    );
    if (
      !live ||
      (enabled && !live.available) ||
      live.enabledAgentIds.includes(intent.targetId) === enabled ||
      !privateSkillTargets(data.current, live).some((agent) => agent.id === intent.targetId)
    )
      return;
    const current = begin('write');
    if (!current) return;
    const mutation = { selection: intent, enabled };
    onBusyChange(true);
    setFeedback(undefined);
    let conflict: 'apps:privateSkillChanged' | 'apps:privateSkillNameConflict' | undefined;
    try {
      try {
        await scope.request(
          `/private-skills/${encodeURIComponent(intent.id)}/bots/${encodeURIComponent(intent.targetId)}`,
          'PUT',
          { enabled, expectedRevision: intent.revision },
        );
      } catch (cause) {
        if (!current()) return;
        if (cause instanceof ApiError && cause.status === 409) {
          if (cause.code === 'PRIVATE_SKILL_CHANGED') conflict = 'apps:privateSkillChanged';
          if (cause.code === 'PRIVATE_SKILL_NAME_CONFLICT')
            conflict = 'apps:privateSkillNameConflict';
        }
      }
      if (!current()) return;
      // Only the reloaded shelf can establish the current target binding.
      if (!conflict) unresolved.current = mutation;
      const result = await read(current);
      if (!result) return;
      if (conflict) setFeedback({ kind: 'error', text: uiText(conflict) });
      else reconcile(result, mutation);
    } catch {
      if (!current()) return;
      authoritative.current = false;
      setUnconfirmed(true);
      setFeedback({
        kind: 'error',
        text: uiText(conflict || 'apps:privateSkillUnconfirmed'),
      });
    } finally {
      finish(current);
    }
  }

  return {
    shelf,
    selection,
    phase,
    feedback,
    unconfirmed,
    choose,
    refresh,
    update,
    isBusy: () => busy.current !== 'idle',
  };
}

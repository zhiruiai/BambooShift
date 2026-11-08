import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { type GroupSettingsSnapshot } from '../../../../shared/group-settings';
import type { BotAgent } from '../../../../shared/types';
import { ApiError } from '../../api';
import { createAppConnectionScope } from '../../appConnections';
import '../GroupSettingsDialog.css';
import { GroupDraft, payload, problem, Props, toDraft } from './parts';
export function useGroupSettingsContent(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createAppConnectionScope({ ...props, identity: () => latest.current }),
  );
  const [base, setBase] = useState<GroupSettingsSnapshot>(),
    [observed, setObserved] = useState<GroupSettingsSnapshot>();
  const [draft, setDraft] = useState(() => toDraft(props.conversation));
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [review, setReview] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [leave, setLeave] = useState(false),
    [replace, setReplace] = useState(false);
  const running = useRef(false),
    reading = useRef(false),
    reviewRef = useRef(false),
    sequence = useRef(0),
    baseline = useRef(''),
    draftRef = useRef(draft);
  draftRef.current = draft;
  const endpoint = `/conversations/${encodeURIComponent(props.conversation.id)}/settings`;
  const current = () => scope.current(scope.ticket());
  const dirty = JSON.stringify(payload(draft)) !== baseline.current;
  function accept(snapshot: GroupSettingsSnapshot) {
    const next = toDraft(snapshot.conversation);
    setBase(snapshot);
    setDraft(next);
    draftRef.current = next;
    baseline.current = JSON.stringify(payload(next));
    setObserved(undefined);
    setReview(false);
    reviewRef.current = false;
    setReplace(false);
  }
  function validate(snapshot: GroupSettingsSnapshot) {
    if (
      !snapshot?.conversation?.isGroup ||
      snapshot.conversation.id !== props.conversation.id ||
      typeof snapshot.revision !== 'string' ||
      !/^[a-f\d]{64}$/.test(snapshot.revision)
    )
      throw new Error(uiText('settings:text_c1d94973a0de'));
    return snapshot;
  }
  async function read() {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || running.current || reading.current) return;
    const order = ++sequence.current;
    reading.current = true;
    setLoading(true);
    setError('');
    try {
      const snapshot = validate(await scope.request<GroupSettingsSnapshot>(endpoint));
      if (!scope.current(ticket) || order !== sequence.current) return;
      if (!baseline.current) accept(snapshot);
      else {
        setObserved(snapshot);
        reviewRef.current = true;
        setReview(true);
      }
    } catch (cause) {
      if (scope.current(ticket) && order === sequence.current) setError((cause as Error).message);
    } finally {
      if (order === sequence.current) {
        reading.current = false;
        if (scope.current(ticket)) setLoading(false);
      }
    }
  }
  useEffect(() => {
    scope.resume();
    void read();
    return () => {
      sequence.current++;
      reading.current = false;
      scope.suspend();
    };
  }, [scope]);
  function update(change: (value: GroupDraft) => GroupDraft) {
    if (!current() || running.current || !base) return;
    setDraft((value) => change(value));
    setNotice('');
  }
  function close() {
    if (!current() || running.current) return;
    if (dirty && baseline.current) setLeave(true);
    else latest.current.onClose();
  }
  async function save() {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || running.current || reading.current || reviewRef.current || !base)
      return;
    const body = payload(draftRef.current),
      issue = problem(body, latest.current.agents, base.conversation.agentIds);
    if (issue) {
      setError(issue);
      return;
    }
    running.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const snapshot = validate(
        await scope.request<GroupSettingsSnapshot>(endpoint, 'PATCH', {
          ...body,
          title: body.title.trim(),
          expectedRevision: base.revision,
        }),
      );
      if (!scope.current(ticket)) return;
      accept(snapshot);
      setNotice(uiText('settings:text_d4309d1ab0b6'));
      latest.current.onSaved(snapshot.conversation);
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError((cause as Error).message);
      if (
        !(cause instanceof ApiError) ||
        cause.status === 0 ||
        cause.status === 408 ||
        cause.status === 409 ||
        cause.status === 401 ||
        cause.status === 403 ||
        cause.status >= 500
      ) {
        reviewRef.current = true;
        setReview(true);
        setObserved(undefined);
      }
    } finally {
      running.current = false;
      if (scope.current(ticket)) setSaving(false);
    }
  }
  const locked = saving || !base;
  const members = draft.agentIds.map(
    (id) =>
      latest.current.agents.find((agent) => agent.id === id) ||
      ({
        id,
        name: uiText('settings:text_0583e9855b7b'),
        role: uiText('settings:text_adf60c70f5a2'),
      } as BotAgent),
  );

  return {
    close,
    error,
    notice,
    leave,
    setLeave,
    current,
    running,
    latest,
    review,
    loading,
    saving,
    read,
    observed,
    props,
    dirty,
    setReplace,
    accept,
    setBase,
    baseline,
    setObserved,
    setReview,
    reviewRef,
    setError,
    setNotice,
    replace,
    base,
    save,
    locked,
    draft,
    update,
    members,
    draftRef,
  };
}

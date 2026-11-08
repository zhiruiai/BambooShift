import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../../../shared/types';
import { ApiError } from '../../api';
import { createChatSendScope } from '../../chatSendScope';
import { fixedWorkspaceApi } from '../../fixedWorkspaceApi';
import { uiText } from '../../i18n';
import {
  computerApprovalFingerprint,
  computerApprovalPath,
  mayAllowComputerAction,
  mayDecideComputerAction,
  parseChatComputerAction,
  type ChatComputerAction,
} from './chatApproval';

export type ChatComputerApprovalProps = {
  message: Message;
  owner?: boolean;
  userId?: string;
  workspaceId?: string;
  onChanged?: () => Promise<unknown>;
};

export function useChatComputerApproval(props: ChatComputerApprovalProps) {
  const current = useRef(props);
  current.current = props;
  const [scope] = useState(() =>
    createChatSendScope({ ...props, identity: () => current.current }),
  );
  const [request] = useState(() => fixedWorkspaceApi(scope));
  const [received, setReceived] = useState<ChatComputerAction>();
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false),
    submitted = useRef(false);
  const original = parseChatComputerAction(props.message.metadata?.action);
  const action =
    original &&
    received &&
    original.status === 'pending' &&
    computerApprovalFingerprint(original) === computerApprovalFingerprint(received)
      ? received
      : original;
  const displayed = useRef(action);
  displayed.current = action;
  useEffect(() => {
    scope.resume();
    const expire = () => {
      submitted.current = true;
      setBusy(false);
      scope.suspend();
    };
    window.addEventListener('openbot:account-expired', expire);
    window.addEventListener('openbot:unpaired', expire);
    return () => {
      window.removeEventListener('openbot:account-expired', expire);
      window.removeEventListener('openbot:unpaired', expire);
      scope.suspend();
    };
  }, [scope]);
  useEffect(() => {
    if (original && original.status !== 'pending') {
      submitted.current = true;
      setUnknown(false);
      setError('');
    }
  }, [original?.status]);

  function permitted(ticket: number, reviewed: ChatComputerAction, approve = false) {
    const now = current.current,
      live = displayed.current;
    return (
      scope.current(ticket) &&
      !!now.onChanged &&
      now.message.id === props.message.id &&
      now.message.conversationId === props.message.conversationId &&
      !!live &&
      computerApprovalFingerprint(live) === computerApprovalFingerprint(reviewed) &&
      mayDecideComputerAction(now.message, live, { userId: now.userId, isOwner: !!now.owner }) &&
      (!approve || mayAllowComputerAction(live))
    );
  }

  async function fresh(reviewed: ChatComputerAction) {
    const base = computerApprovalPath(current.current.message, reviewed);
    if (!base) throw new Error(uiText('computer:inlineApprovalChanged'));
    const actions = await request<unknown>(`${base}/actions`);
    const found = Array.isArray(actions)
      ? actions.map(parseChatComputerAction).find((item) => item?.id === reviewed.id)
      : undefined;
    if (!found) throw new Error(uiText('computer:inlineApprovalMissing'));
    if (computerApprovalFingerprint(found) !== computerApprovalFingerprint(reviewed))
      throw new Error(uiText('computer:inlineApprovalChanged'));
    return { found, base };
  }

  async function decide(approve: boolean) {
    const ticket = scope.ticket(),
      reviewed = action;
    if (!reviewed || running.current || submitted.current || !permitted(ticket, reviewed, approve))
      return;
    running.current = true;
    setBusy(true);
    setError('');
    let sent = false;
    try {
      const { found, base } = await fresh(reviewed);
      if (!permitted(ticket, reviewed, approve)) return;
      if (found.status !== 'pending') {
        setReceived(found);
        submitted.current = true;
        await current.current.onChanged?.();
        return;
      }
      // The server rechecks requester, target, takeover and task state atomically.
      submitted.current = true;
      sent = true;
      const response = await request<unknown>(
        `${base}/actions/${encodeURIComponent(reviewed.id)}/${approve ? 'approve' : 'reject'}`,
        'POST',
      );
      if (!scope.current(ticket)) return;
      const receipt = parseChatComputerAction(response);
      if (
        !receipt ||
        receipt.status === 'pending' ||
        computerApprovalFingerprint(receipt) !== computerApprovalFingerprint(reviewed)
      )
        throw new Error(uiText('computer:inlineApprovalUnknown'));
      setReceived(receipt);
      setUnknown(false);
      sent = false;
      await current.current.onChanged?.();
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError(cause instanceof Error ? cause.message : uiText('computer:inlineApprovalFailed'));
      setUnknown(sent);
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        setBusy(false);
        scope.suspend();
      }
    } finally {
      running.current = false;
      if (scope.current(ticket)) setBusy(false);
    }
  }

  async function refresh() {
    const ticket = scope.ticket(),
      reviewed = action;
    if (!reviewed || !scope.current(ticket) || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const { found } = await fresh(reviewed);
      if (!scope.current(ticket)) return;
      setReceived(found.status === 'pending' ? undefined : found);
      submitted.current = found.status !== 'pending';
      setUnknown(false);
      setError('');
      await current.current.onChanged?.();
    } catch (cause) {
      if (scope.current(ticket))
        setError(cause instanceof Error ? cause.message : uiText('computer:inlineApprovalFailed'));
    } finally {
      running.current = false;
      if (scope.current(ticket)) setBusy(false);
    }
  }

  const allowed =
    !!props.onChanged &&
    mayDecideComputerAction(props.message, action, {
      userId: props.userId,
      isOwner: !!props.owner,
    });
  return {
    action,
    busy,
    unknown,
    error,
    decide,
    refresh,
    canDecide: allowed,
    disabled: busy || unknown || submitted.current || !scope.current(scope.ticket()),
    allowDisabled: !action || !mayAllowComputerAction(action),
    received: action && action !== original,
  };
}

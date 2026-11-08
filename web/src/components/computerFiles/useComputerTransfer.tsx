import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { canDecideAction } from '../../../../shared/approvals';
import { useAccount } from '../../AccountContext';
import { createAppConnectionScope } from '../../appConnections';
import { currentWorkspaceId } from '../../workspace-scope';
import '../ComputerFiles.css';
import { FileComputerAction, TransferContext, contextKey, unavailableMessage } from './types';
export function useComputerTransfer(
  onComplete: () => Promise<void>,
  currentContext: TransferContext,
) {
  const account = useAccount();
  const identity = useRef({
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: account?.session.user?.id,
    isOwner: !account || account.workspace.role === 'owner',
  });
  identity.current = {
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: account?.session.user?.id,
    isOwner: !account || account.workspace.role === 'owner',
  };
  const [scope] = useState(() =>
    createAppConnectionScope({ ...identity.current, identity: () => identity.current }),
  );
  const [action, setAction] = useState<FileComputerAction | null>(null),
    [context, setContext] = useState<TransferContext | null>(null),
    [error, setError] = useState(''),
    [requesting, setRequesting] = useState(false);
  const mounted = useRef(true),
    busy = useRef(false),
    latest = useRef<FileComputerAction | null>(null),
    requestKey = useRef(''),
    requestContext = useRef<TransferContext | null>(null),
    completed = useRef(new Set<string>()),
    callback = useRef(onComplete);
  const currentScope = contextKey(currentContext);
  const observedScope = useRef(currentScope);
  callback.current = onComplete;
  useEffect(() => {
    scope.resume();
    mounted.current = true;
    return () => {
      mounted.current = false;
      scope.suspend();
    };
  }, []);
  function accept(value: FileComputerAction) {
    if (!scope.current(scope.ticket())) return;
    latest.current = value;
    if (mounted.current) {
      setAction(value);
      if (value.status === 'error' || value.status === 'rejected' || value.status === 'unavailable')
        setError(value.error || uiText('computer:text_df2ce510b063'));
      else setError('');
    }
  }
  useEffect(() => {
    if (action?.status !== 'done' || completed.current.has(action.id)) return;
    completed.current.add(action.id);
    void callback.current().catch(() => {
      if (mounted.current) setError(uiText('computer:text_328356824813'));
    });
  }, [action?.id, action?.status]);
  useEffect(() => {
    if (!action || !['pending', 'running'].includes(action.status)) return;
    let active = true,
      checking = false;
    const check = async () => {
      if (checking || busy.current) return;
      checking = true;
      try {
        const items = await scope.request<FileComputerAction[]>('/computer/actions');
        const current = items.find((item) => item.id === action.id);
        if (active && latest.current?.id === action.id)
          accept(current || { ...action, status: 'unavailable', error: unavailableMessage() });
      } catch (cause) {
        if (active && mounted.current) setError((cause as Error).message);
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [action?.id, action?.status]);
  async function perform(body: Record<string, unknown>, submittedContext: TransferContext) {
    const ticket = scope.ticket();
    if (busy.current || !scope.current(ticket)) return;
    busy.current = true;
    setRequesting(true);
    setError('');
    const key = JSON.stringify(body);
    try {
      let current = latest.current;
      if (
        requestKey.current === key &&
        requestContext.current &&
        contextKey(requestContext.current) === contextKey(submittedContext) &&
        current &&
        ['pending', 'running'].includes(current.status)
      ) {
        const previous = current;
        const items = await scope.request<FileComputerAction[]>('/computer/actions');
        if (!scope.current(ticket)) return;
        current = items.find((item) => item.id === previous.id) || null;
        if (!current) {
          accept({ ...previous, status: 'unavailable', error: unavailableMessage() });
          return;
        }
      } else {
        latest.current = null;
        setAction(null);
        requestContext.current = { ...submittedContext };
        setContext(requestContext.current);
        current = await scope.request<FileComputerAction>('/computer/actions', 'POST', {
          ...body,
          ...(submittedContext.targetRevision
            ? { expectedTargetRevision: submittedContext.targetRevision }
            : {}),
        });
        if (!scope.current(ticket)) return;
        requestKey.current = key;
      }
      accept(current);
      // Only the single upload created by this explicit user action is approved here.
      if (
        current.status === 'pending' &&
        current.type === 'upload_file' &&
        body.type === 'upload_file' &&
        canDecideAction(current.requester, identity.current)
      ) {
        current = await scope.request<FileComputerAction>(
          `/computer/actions/${encodeURIComponent(current.id)}/approve`,
          'POST',
        );
        if (!scope.current(ticket)) return;
        accept(current);
      }
    } catch (cause) {
      if (mounted.current && scope.current(ticket)) setError((cause as Error).message);
    } finally {
      busy.current = false;
      if (mounted.current && scope.current(ticket)) setRequesting(false);
    }
  }
  function reset() {
    if (busy.current || latest.current?.status === 'running') return;
    latest.current = null;
    requestKey.current = '';
    requestContext.current = null;
    setAction(null);
    setContext(null);
    setError('');
  }
  function clearSettled() {
    if (busy.current || (latest.current && ['pending', 'running'].includes(latest.current.status)))
      return;
    reset();
  }
  useEffect(() => {
    const changed = observedScope.current !== currentScope;
    observedScope.current = currentScope;
    if (changed || (requestContext.current && contextKey(requestContext.current) !== currentScope))
      clearSettled();
  }, [currentScope, action?.status, requesting]);
  return {
    action,
    context,
    error,
    requesting,
    active: requesting || action?.status === 'running',
    perform,
    reset,
    clearSettled,
  };
}

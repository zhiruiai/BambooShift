import { useEffect, useRef, useState } from 'react';
import type { Routine, BotAgent, Conversation } from '../../../shared/types';
import type { RoutineTransferReceipt } from '../../../shared/routine-transfers';
import { routineConfigSnapshot } from '../../../shared/routine-operations';
import { useAccount } from '../AccountContext';
import { currentWorkspaceId } from '../workspace-scope';
import {
  createRoutineTransferClient,
  routineTransferTargets,
  type TransferState,
} from '../routineTransfers';
import { uiText } from '../i18n';
import { Dialog } from './UI';
import { Avatar } from './Avatar';
import './RoutineTransferDialog.css';
export function RoutineTransferDialog(props: {
  routine: Routine;
  currentRoutine?: Routine;
  agents: BotAgent[];
  conversations: Conversation[];
  onClose: () => void;
  onTransferred?: (receipt: RoutineTransferReceipt) => Promise<void> | void;
}) {
  const account = useAccount();
  if (!account || account.workspace.role !== 'owner' || account.workspace.kind !== 'personal')
    return null;
  return (
    <TransferView
      key={`${account.session.user?.id}:${account.workspace.id}:${props.routine.id}`}
      {...props}
      userId={account.session.user?.id}
      workspaceId={account.workspace.id}
    />
  );
}
export function TransferView({
  routine,
  currentRoutine,
  agents,
  conversations,
  onClose,
  onTransferred,
  userId,
  workspaceId,
}: Parameters<typeof RoutineTransferDialog>[0] & { userId?: string; workspaceId?: string }) {
  const identity = useRef({ userId, workspaceId });
  identity.current = { userId, workspaceId };
  const latest = useRef({ onTransferred, onClose });
  latest.current = { onTransferred, onClose };
  const [state, setState] = useState<TransferState>({ busy: false, error: '', checked: false });
  const [client] = useState(() =>
    createRoutineTransferClient({
      ...identity.current,
      routineId: routine.id,
      identity: () => identity.current,
      locationWorkspace: currentWorkspaceId,
      onState: setState,
      onTransferred: (receipt) => latest.current.onTransferred?.(receipt),
    }),
  );
  const [reviewed, setReviewed] = useState(() => structuredClone(routine)),
    [target, setTarget] = useState('');
  const choices = routineTransferTargets(agents, conversations, reviewed.agentId);
  const chosen = choices.find((c) => c.agent.id === target);
  const changed =
    !currentRoutine ||
    JSON.stringify(routineConfigSnapshot(currentRoutine)) !==
      JSON.stringify(routineConfigSnapshot(reviewed));
  const locked = state.busy || !client.current();
  useEffect(() => {
    client.resume();
    void client.check();
    return () => client.close();
  }, [client]);
  const receipt = state.receipt;
  return (
    <Dialog
      title={uiText('workspace:routineTransferTitle')}
      subtitle={uiText('workspace:routineTransferScope')}
      onClose={() => {
        if (!locked) onClose();
      }}
    >
      <section className="routine-transfer">
        <h3>{reviewed.title}</h3>
        <p>{uiText('workspace:routineTransferPreserves')}</p>
        <p className="section-help">{uiText('workspace:routineTransferIdle')}</p>
        {!!reviewed.publicSearchQueries?.length && (
          <p className="section-help">{uiText('routines:publicSearchTransfer')}</p>
        )}
        {state.error && (
          <p className="error-text" role="alert">
            {state.error}
          </p>
        )}
        {receipt ? (
          <div role="status">
            <p>
              {uiText(
                receipt.status === 'missing'
                  ? 'workspace:routineTransferMissing'
                  : receipt.routine?.agentId === receipt.targetAgentId &&
                      receipt.routine.conversationId === receipt.targetConversationId
                    ? 'workspace:routineTransferDone'
                    : 'workspace:routineTransferLaterChanged',
              )}
            </p>
            <button
              className="primary-button"
              disabled={locked}
              onClick={() => {
                if (client.current() && client.acknowledge()) onClose();
              }}
            >
              {uiText('workspace:routineTransferClose')}
            </button>
          </div>
        ) : state.requestId ? (
          <div className="routine-transfer-recovery">
            <p>{uiText('workspace:routineTransferUnknown')}</p>
            <button
              className="secondary-button"
              disabled={locked}
              onClick={() => void client.check()}
            >
              {uiText('workspace:routineTransferCheck')}
            </button>
            {client.canRetry && (
              <button
                className="secondary-button"
                disabled={locked}
                onClick={() => void client.retry()}
              >
                {uiText('workspace:routineTransferRetry')}
              </button>
            )}
            <button
              className="secondary-button"
              disabled={locked}
              onClick={() => void client.cancel()}
            >
              {uiText('workspace:routineTransferCancel')}
            </button>
          </div>
        ) : (
          <>
            {changed && (
              <div role="status">
                <p>{uiText('workspace:routineTransferChanged')}</p>
                {currentRoutine && (
                  <button
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => {
                      if (client.current()) setReviewed(structuredClone(currentRoutine));
                    }}
                  >
                    {uiText('workspace:routineTransferReload')}
                  </button>
                )}
              </div>
            )}
            <label>
              {uiText('workspace:routineTransferTarget')}
              <select
                value={target}
                disabled={locked}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">{uiText('workspace:routineTransferChoose')}</option>
                {choices.map((c) => (
                  <option key={c.agent.id} value={c.agent.id}>
                    {c.agent.name} · {c.agent.role}
                  </option>
                ))}
              </select>
            </label>
            {!choices.length && <p>{uiText('workspace:routineTransferNoTargets')}</p>}
            {chosen && (
              <div className="routine-transfer-destination">
                <Avatar agent={chosen.agent} size={36} />
                <div>
                  <strong>{chosen.agent.name}</strong>
                  <p>{chosen.conversation.title}</p>
                </div>
              </div>
            )}
            <button
              className="primary-button"
              disabled={locked || changed || !chosen}
              onClick={() => {
                if (chosen && !changed && client.current())
                  void client.start(reviewed, chosen.agent.id, chosen.conversation.id);
              }}
            >
              {uiText('workspace:routineTransferConfirm')}
            </button>
          </>
        )}
      </section>
    </Dialog>
  );
}

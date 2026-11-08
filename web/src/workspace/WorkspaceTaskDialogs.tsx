import { uiText } from '../i18n';
import { routineConfigSnapshot } from '../../../shared/routine-operations';
import { ComputerDialog } from '../components/ComputerDialog';
import { SendFileToComputerDialog } from '../components/ComputerFiles';
import { MemoryDialog } from '../components/MemoryDialog';
import { RoutineDetails } from '../components/RoutineDetails';
import { RoutineDialog } from '../components/RoutineDialog';
import { SkillsDialog } from '../components/SkillsDialog';
import { Dialog } from '../components/UI';
import type { WorkspaceModel } from './types';

export function WorkspaceTaskDialogs({
  api,
  modal,
  members,
  memories,
  busy,
  setModal,
  formAction,
  action,
  canManage,
  account,
  sendIdentity,
  currentUserId,
  sendScope,
  sync,
  refresh,
  openRoutineOperation,
  openRoutineRun,
  openRoutineChat,
  data,
  routineToEdit,
  routineInitialAction,
  setRoutineInitialAction,
  routines,
  selected,
  setBusy,
  setToast,
  routineChatPending,
  routineChatBusy,
  setRoutineChatPending,
  routineChatError,
  setRoutineChatError,
  skillsAgentId,
  setSkillsAgentId,
  packagedSkillDraft,
  skills,
  transferFile,
  setTransferFile,
  computerConversation,
  navigationScope,
  computerAgentId,
  setComputerAgentId,
  setComputerPanel,
  computerPanel,
}: Pick<
  WorkspaceModel,
  | 'api'
  | 'modal'
  | 'members'
  | 'memories'
  | 'busy'
  | 'setModal'
  | 'formAction'
  | 'action'
  | 'canManage'
  | 'account'
  | 'sendIdentity'
  | 'currentUserId'
  | 'sendScope'
  | 'sync'
  | 'refresh'
  | 'openRoutineOperation'
  | 'openRoutineRun'
  | 'openRoutineChat'
  | 'data'
  | 'routineToEdit'
  | 'routineInitialAction'
  | 'setRoutineInitialAction'
  | 'routines'
  | 'selected'
  | 'setBusy'
  | 'setToast'
  | 'routineChatPending'
  | 'routineChatBusy'
  | 'setRoutineChatPending'
  | 'routineChatError'
  | 'setRoutineChatError'
  | 'skillsAgentId'
  | 'setSkillsAgentId'
  | 'packagedSkillDraft'
  | 'skills'
  | 'transferFile'
  | 'setTransferFile'
  | 'computerConversation'
  | 'navigationScope'
  | 'computerAgentId'
  | 'setComputerAgentId'
  | 'setComputerPanel'
  | 'computerPanel'
>) {
  return (
    <>
      {modal === 'memory' && (
        <MemoryDialog
          agents={members}
          memories={memories}
          busy={busy}
          onClose={() => setModal(null)}
          onAdd={(body) =>
            formAction(() => api('/memories', 'POST', body), uiText('workspace:text_f54726ed5fe3'))
          }
          onDelete={(id) =>
            action(() => api(`/memories/${id}`, 'DELETE'), uiText('workspace:text_94078a287165'))
          }
          onEdit={(id, content) =>
            formAction(
              () => api(`/memories/${id}`, 'PATCH', { content }),
              uiText('workspace:text_bf1eab87a418'),
            )
          }
        />
      )}
      {modal === 'routine' &&
        (canManage ? (
          <RoutineDialog
            canTransferRoutines={account?.workspace.kind === 'personal' && canManage}
            canManagePublicSearch={account?.workspace.role === 'owner'}
            canManageWebhooks={account?.workspace.role === 'owner'}
            workspaceId={sendIdentity.current.workspaceId}
            userId={currentUserId}
            onChanged={async (receipt) => {
              if (
                !sendScope.current(sendScope.ticket()) ||
                receipt.userId !== currentUserId ||
                receipt.workspaceId !== sendIdentity.current.workspaceId
              )
                return;
              sync.written();
              await refresh();
            }}
            onOpenConversation={openRoutineOperation}
            onOpenRun={openRoutineRun}
            onChatRequest={openRoutineChat}
            defaultTimeZone={data.workspaceTimeZone?.timeZone}
            agents={members}
            allAgents={data.agents}
            conversations={data.conversations}
            initialRoutineId={routineToEdit}
            initialAction={routineInitialAction}
            onInitialActionConsumed={() => setRoutineInitialAction('view')}
            routines={routines}
            busy={busy}
            conversationId={selected}
            onClose={() => setModal(null)}
            onSave={async (body, id) => {
              if (!id) throw Error(uiText('workspace:text_71eaee0a3ee9'));
              const ticket = sendScope.ticket();
              if (!sendScope.current(ticket)) throw Error(uiText('workspace:text_47ec17cac233'));
              setBusy(true);
              try {
                await sendScope.request(`/routines/${id}`, 'PATCH', body);
                if (!sendScope.current(ticket)) return;
                sync.written();
                await refresh();
                if (sendScope.current(ticket)) setToast(uiText('workspace:text_f6f363f8dc04'));
              } finally {
                if (sendScope.current(ticket)) setBusy(false);
              }
            }}
            onToggle={(r) =>
              action(() => sendScope.request(`/routines/${r.id}`, 'PATCH', { enabled: !r.enabled }))
            }
            onDelete={async (routine) => {
              const ticket = sendScope.ticket();
              if (!sendScope.current(ticket)) throw Error(uiText('workspace:text_a8e6317e54f4'));
              setBusy(true);
              try {
                await sendScope.request(`/routines/${routine.id}`, 'DELETE', {
                  expectedRoutine: routineConfigSnapshot(routine),
                });
                if (!sendScope.current(ticket)) return;
                sync.written();
                await refresh();
                if (sendScope.current(ticket)) setToast(uiText('workspace:text_a91b071e086d'));
              } finally {
                if (sendScope.current(ticket)) setBusy(false);
              }
            }}
          />
        ) : (
          <RoutineDetails
            workspaceId={sendIdentity.current.workspaceId}
            userId={currentUserId}
            onOpenRun={openRoutineRun}
            routines={routines}
            agents={data.agents}
            conversations={data.conversations}
            initialRoutineId={routineToEdit}
            onClose={() => setModal(null)}
          />
        ))}
      {routineChatPending && (
        <Dialog
          title={uiText('workspace:text_3d085d6f4c48')}
          subtitle={uiText('workspace:text_114ca958fbe0', { value0: routineChatPending.agentName })}
          onClose={() => {
            if (!routineChatBusy) {
              setRoutineChatPending(undefined);
              setModal('routine');
            }
          }}
        >
          <p>{uiText('workspace:text_0bbea66e073e')}</p>
          {routineChatError && (
            <p className="form-error" role="alert">
              {routineChatError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="secondary-button"
              disabled={routineChatBusy}
              onClick={() => {
                setRoutineChatPending(undefined);
                setModal('routine');
              }}
            >
              {uiText('workspace:text_0e77ad0a8f17')}
            </button>
            <button
              className="primary-button"
              disabled={routineChatBusy}
              onClick={() => {
                setRoutineChatError('');
                void openRoutineChat(routineChatPending.request, routineChatPending.draft).catch(
                  (cause) => {
                    if (sendScope.current(sendScope.ticket()))
                      setRoutineChatError((cause as Error).message);
                  },
                );
              }}
            >
              {routineChatBusy
                ? uiText('workspace:text_821ffb8cd6a2')
                : uiText('workspace:text_75ddaeeda017')}
            </button>
          </div>
        </Dialog>
      )}
      {modal === 'skills' && (
        <SkillsDialog
          key={navigationScope}
          agents={skillsAgentId ? data.agents.filter((item) => item.id === skillsAgentId) : members}
          skills={
            skillsAgentId ? data.skills.filter((item) => item.agentId === skillsAgentId) : skills
          }
          readOnly={!canManage}
          initialDraft={
            canManage &&
            packagedSkillDraft?.scope === navigationScope &&
            packagedSkillDraft.agentId === skillsAgentId
              ? packagedSkillDraft
              : undefined
          }
          busy={busy}
          team={
            account?.workspace.kind === 'team'
              ? {
                  workspaceId: account.workspace.id,
                  agents: data.agents,
                  request: api,
                  onImported: (agentId) => {
                    if (!sendScope.current(sendScope.ticket())) return;
                    setSkillsAgentId(agentId);
                    sync.written();
                    void refresh();
                  },
                }
              : undefined
          }
          onClose={() => setModal(null)}
          onAdd={(body) =>
            formAction(() => api('/skills', 'POST', body), uiText('workspace:text_7ff7bc943cd1'))
          }
          onTransition={(id, transition, expectedActiveId) =>
            formAction(
              () => api(`/skills/${id}/${transition}`, 'POST', { expectedActiveId }),
              transition === 'disable'
                ? uiText('workspace:text_bd361a719202')
                : uiText('workspace:text_186e0911f70b'),
            )
          }
        />
      )}
      {modal === 'file-transfer' && transferFile && (
        <SendFileToComputerDialog
          {...transferFile}
          computer={data.computer}
          refresh={refresh}
          onClose={() => {
            setModal(null);
            setTransferFile(null);
          }}
        />
      )}
      {modal === 'computer' && computerConversation.scope === navigationScope && (
        <ComputerDialog
          key={`${navigationScope}:${computerAgentId || ''}`}
          data={data}
          agentId={computerAgentId}
          onSelectBot={(id) => {
            setComputerAgentId(id);
            setComputerPanel('screen');
          }}
          conversationId={computerConversation.id}
          conversationTitle={computerConversation.title}
          initialPanel={computerPanel}
          busy={busy}
          onClose={() => setModal(null)}
          onAction={action}
          refresh={refresh}
        />
      )}
    </>
  );
}

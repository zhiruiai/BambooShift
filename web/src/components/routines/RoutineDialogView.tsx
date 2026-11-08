import { uiText } from '../../i18n';
import { RoutineOverview } from '../RoutineDetails';
import '../RoutineDialog.css';
import { RoutineRunHistory } from '../RoutineRunHistory';
import { Dialog } from '../UI';
import { RoutineListView } from './RoutineListView';
import { RoutineOperationRecoveryView } from './RoutineOperationRecoveryView';
import { RoutineScheduleEditorView } from './RoutineScheduleEditorView';
import { RoutineWebhookPanel } from './RoutineWebhookPanel';
import { RoutineTransferDialog } from '../RoutineTransferDialog';
import type { useRoutineDialog } from './useRoutineDialog';
export type RoutineDialogModel = ReturnType<typeof useRoutineDialog>;
export function RoutineDialogView(model: RoutineDialogModel) {
  const {
    navigate,
    onClose,
    routines,
    editing,
    disabled,
    selectedId,
    mounted,
    operations,
    setSelectedId,
    allAgents,
    clock,
    onChatRequest,
    chatDisabled,
    requestChat,
    edit,
    onToggle,
    savingRef,
    busy,
    askDelete,
    selected,
    conversations,
    userId,
    workspaceId,
    deleting,
    onOpenRun,
    openRun,
    deleteError,
    setDeleting,
    setDeleteError,
    confirmDelete,
    saving,
    onOpenConversation,
    openResult,
    formDisabled,
    editingMissing,
    setError,
    targetConversation,
    availableAgents,
    draft,
    draftRef,
    conversationId,
    createDraft,
    setSaving,
    onSave,
    resetEditor,
    change,
    currentEditing,
    titleRef,
    error,
    feedbackRef,
    leave,
    setLeave,
    openingRef,
  } = model;
  return (
    <Dialog
      title={uiText('routines:text_8983a65a2967')}
      subtitle={uiText('routines:text_10a1eea0e20c')}
      className="routine-library-dialog"
      onClose={() => navigate(onClose)}
    >
      <RoutineListView {...model} />
      {model.transferring && (
        <RoutineTransferDialog
          routine={model.transferring}
          currentRoutine={routines.find((routine) => routine.id === model.transferring?.id)}
          agents={allAgents}
          conversations={conversations}
          onClose={() => model.setTransferring(undefined)}
          onTransferred={model.onChanged}
        />
      )}
      {selected && (
        <section
          className="routine-detail-panel"
          aria-label={uiText('routines:text_c82ca434a7d3', { value0: selected.title })}
        >
          <h3>{selected.title}</h3>
          <RoutineOverview
            routine={selected}
            agents={allAgents}
            conversations={conversations}
            showPublicSearch={model.canManagePublicSearch}
          />
          {model.canConfigureWebhook(selected) && (
            <RoutineWebhookPanel
              key={`${userId}:${workspaceId}:${selected.id}:${selected.agentId}:${selected.conversationId}`}
              routineId={selected.id}
              workspaceId={workspaceId}
              userId={userId}
              disabled={disabled || !!deleting || !!model.transferring}
            />
          )}
          <RoutineRunHistory
            key={`${userId}:${workspaceId}:${selected.id}`}
            routineId={selected.id}
            workspaceId={workspaceId}
            userId={userId}
            timeZone={selected.timeZone}
            refreshKey={`${selected.lastRunAt || ''}:${operations.state.receipt?.kind === 'run' ? operations.state.receipt.requestId + operations.state.receipt.status : ''}`}
            disabled={disabled || !!deleting}
            onOpenRun={onOpenRun ? (run) => navigate(() => void openRun(run)) : undefined}
          />
        </section>
      )}
      {deleting && (
        <section
          className="routine-delete-confirm bot-form-notice"
          role="alert"
          aria-label={uiText('routines:text_054cb9854ef7')}
        >
          <strong>
            {uiText('routines:text_9fad3beb4471')}
            {deleting.title}
            {uiText('common:punct_a33706e414ed')}
          </strong>
          <p>{uiText('routines:text_7d54c74f5261')}</p>
          <p>{uiText('routines:text_77f4797d861e')}</p>
          {deleteError && <p className="error-text">{deleteError}</p>}
          <div className="time-zone-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() => {
                if (!savingRef.current) {
                  setDeleting(undefined);
                  setDeleteError('');
                }
              }}
            >
              {uiText('routines:text_a6926595ce6b')}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={disabled}
              onClick={() => void confirmDelete()}
            >
              {saving
                ? uiText('routines:text_4fd4f40094d4')
                : uiText('routines:text_48b49b802bb2', { value0: deleting.title })}
            </button>
          </div>
        </section>
      )}
      {<RoutineOperationRecoveryView {...model} />}
      <RoutineScheduleEditorView {...model} />
      {leave && (
        <div className="bot-form-notice" role="alert">
          <strong>{uiText('routines:text_aeaad8c4c7e5')}</strong>
          <p>
            {operations.state.request && !operations.state.receipt
              ? uiText('routines:text_844fbe6657a8')
              : uiText('routines:text_b917b7e23e99')}
          </p>
          <div className="time-zone-actions">
            <button type="button" className="secondary-button" onClick={() => setLeave(null)}>
              {uiText('routines:text_fd4b9e3b6c68')}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                if (
                  !mounted.current ||
                  !operations.scope.current(operations.scope.ticket()) ||
                  openingRef.current ||
                  savingRef.current ||
                  busy ||
                  operations.getState().busy
                )
                  return;
                const work = leave;
                setLeave(null);
                work();
              }}
            >
              {uiText('routines:text_58e5be3a8762')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

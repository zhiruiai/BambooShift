import { uiText } from '../../i18n';
import { routineOperationLabel } from '../../routineOperations';
import '../RoutineDialog.css';
import type { useRoutineDialog } from './useRoutineDialog';
export type RoutineDialogModel = ReturnType<typeof useRoutineDialog>;
export function RoutineOperationRecoveryView(model: RoutineDialogModel) {
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
    (operations.state.request ||
      operations.state.error ||
      operations.state.message ||
      operations.state.busy) && (
      <section
        className="routine-operation-notice bot-form-notice"
        aria-label={uiText('routines:text_770cdcc17131')}
        role="status"
      >
        <strong>
          {operations.state.request?.kind === 'run'
            ? uiText('routines:text_d30c5af44a18')
            : operations.state.request
              ? uiText('routines:text_db24096f829e')
              : uiText('routines:text_7bb08ba3ce44')}
        </strong>
        <p>
          {operations.state.message ||
            (operations.state.receipt
              ? routineOperationLabel(operations.state.receipt)
              : operations.state.busy
                ? uiText('routines:text_e65f04319105')
                : operations.state.request
                  ? uiText('routines:text_7cee72b5964d')
                  : uiText('routines:text_c498c7a96f11'))}
        </p>
        {operations.state.error && (
          <p className="error-text" role="alert">
            {operations.state.error}
          </p>
        )}
        {operations.state.request &&
          !operations.state.originalAvailable &&
          !operations.state.receipt && <p>{uiText('routines:text_a457144e091a')}</p>}
        {operations.state.request && !operations.state.receipt && (
          <p>{uiText('routines:text_3c3fffa0dbbc')}</p>
        )}
        {operations.state.request && (
          <div className="time-zone-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() => void operations.check()}
            >
              {operations.state.receipt
                ? uiText('routines:text_08c710d2a881')
                : uiText('routines:text_e3a5a9ec15b8')}
            </button>
            {operations.state.canRetry && (
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                onClick={() => void operations.retry()}
              >
                {uiText('routines:text_8d7d39d122a6')}
              </button>
            )}
            {!operations.state.receipt && (
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                onClick={() => void operations.closeRequest()}
              >
                {uiText('routines:text_7ecc069d7f03')}
              </button>
            )}
            {operations.state.receipt &&
              operations.state.receipt.status !== 'missing' &&
              onOpenConversation && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => navigate(() => void openResult(operations.state.receipt!))}
                >
                  {uiText('routines:text_aadeaf97e1f7')}
                </button>
              )}
            {operations.state.receipt && (
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                onClick={() => operations.finish()}
              >
                {uiText('routines:text_7cdcb366c443')}
              </button>
            )}
          </div>
        )}
      </section>
    )
  );
}

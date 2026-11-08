import { uiText } from '../../i18n';
import { Clock3, MessageSquare, Zap } from 'lucide-react';
import { routineScheduleLabel } from '../../routineLabels';
import { routineNextRunLabel } from '../../routineDraft';
import '../RoutineDialog.css';
import { IconButton } from '../UI';
import { RoutineActions } from '../RoutineActions';
import type { useRoutineDialog } from './useRoutineDialog';
export type RoutineDialogModel = ReturnType<typeof useRoutineDialog>;

export function RoutineListView(model: RoutineDialogModel) {
  const {
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
  } = model;
  function allowed() {
    return mounted.current && operations.scope.current(operations.scope.ticket()) && !disabled;
  }
  return (
    <div className="routine-list">
      {routines.map((routine) => (
        <RoutineActions
          className={`routine-management ${editing?.id === routine.id ? 'routine-editing' : ''}`}
          key={routine.id}
          title={routine.title}
          enabled={routine.enabled}
          disabled={disabled}
          deleteDisabled={chatDisabled}
          onEdit={() => {
            if (allowed()) edit(routine);
          }}
          onToggle={() => {
            if (allowed()) void onToggle(routine);
          }}
          onDelete={() => {
            if (allowed()) askDelete(routine);
          }}
          onTransfer={
            model.canTransfer(routine)
              ? () => {
                  if (allowed()) model.askTransfer(routine);
                }
              : undefined
          }
        >
          <Clock3 size={18} />
          <div className="routine-management-copy">
            <button
              type="button"
              className="routine-edit-title"
              disabled={disabled}
              aria-expanded={selectedId === routine.id}
              onClick={() => {
                if (allowed()) setSelectedId(selectedId === routine.id ? undefined : routine.id);
              }}
            >
              <strong>{routine.title}</strong>
            </button>
            <small>
              {routine.enabled
                ? routineScheduleLabel(routine.schedule, routine.timeZone)
                : uiText('routines:text_d817afe414e3', {
                    value0: routineScheduleLabel(routine.schedule, routine.timeZone),
                  })}{' '}
              ·{' '}
              {allAgents.find((agent) => agent.id === routine.agentId)?.name ||
                uiText('routines:text_0583e9855b7b')}
            </small>
            <span className="routine-next-run">{routineNextRunLabel(routine, clock)}</span>
            <p>{routine.prompt}</p>
            {onChatRequest && (
              <button
                type="button"
                className="routine-chat-link"
                aria-label={uiText('routines:text_c5f64ad52903', { value0: routine.title })}
                disabled={chatDisabled}
                onClick={() =>
                  requestChat({
                    kind: 'edit',
                    routineId: routine.id,
                    conversationId: routine.conversationId,
                    agentId: routine.agentId,
                  })
                }
              >
                <MessageSquare size={14} />
                {uiText('routines:text_83f6006cecf9')}
              </button>
            )}
          </div>
          <div className="routine-controls">
            <button
              type="button"
              className="routine-toggle-control"
              role="switch"
              aria-checked={routine.enabled}
              aria-label={uiText(
                routine.enabled ? 'workspace:detailPauseRoutine' : 'workspace:detailResumeRoutine',
              )}
              disabled={disabled}
              onClick={() => {
                if (allowed()) void onToggle(routine);
              }}
            >
              <span className={`toggle ${routine.enabled ? 'on' : ''}`}>
                <span />
              </span>
            </button>
            <IconButton
              label={uiText('routines:text_04eb539709cf')}
              disabled={disabled || !!operations.state.request || !!operations.state.blocked}
              onClick={() => {
                if (
                  !allowed() ||
                  savingRef.current ||
                  busy ||
                  operations.getState().request ||
                  operations.getState().blocked
                )
                  return;
                void operations.run(routine);
              }}
            >
              <Zap size={14} />
            </IconButton>
          </div>
        </RoutineActions>
      ))}
    </div>
  );
}

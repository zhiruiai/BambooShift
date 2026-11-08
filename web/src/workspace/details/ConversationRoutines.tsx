import { Clock3, Plus } from 'lucide-react';
import { uiText } from '../../i18n';
import { routineScheduleLabel } from '../../routineLabels';
import { RoutineActions } from '../../components/RoutineActions';
import { IconButton } from '../../components/UI';
import type { WorkspaceModel } from '../types';

export function ConversationRoutines(
  props: Pick<
    WorkspaceModel,
    | 'canManage'
    | 'routines'
    | 'setRoutineToEdit'
    | 'setRoutineInitialAction'
    | 'setModal'
    | 'busy'
    | 'modal'
    | 'api'
    | 'action'
    | 'sendScope'
    | 'navigationScope'
  >,
) {
  const {
    canManage,
    routines,
    setRoutineToEdit,
    setRoutineInitialAction,
    setModal,
    busy,
    modal,
    api,
    action,
    sendScope,
    navigationScope,
  } = props;
  const current = () => sendScope.current(sendScope.ticket());
  const disabled = busy || modal !== null;
  function open(id: string | null, intent: 'view' | 'edit' | 'delete' = 'view') {
    if (!current() || disabled || (intent !== 'view' && !canManage)) return;
    setRoutineToEdit(id);
    setRoutineInitialAction(intent);
    setModal('routine');
  }
  return (
    <section className="detail-section detail-routines-section">
      <div className="section-label">
        <span>{uiText('workspace:text_8983a65a2967')}</span>
        {canManage && (
          <IconButton
            label={uiText('workspace:text_cec07531424d')}
            disabled={disabled}
            onClick={() => open(null)}
          >
            <Plus size={15} />
          </IconButton>
        )}
      </div>
      {routines.length ? (
        routines.map((routine) => {
          const toggle = () => {
            if (!current() || disabled || !canManage) return;
            void action(() =>
              api(`/routines/${routine.id}`, 'PATCH', { enabled: !routine.enabled }),
            );
          };
          return (
            <RoutineActions
              key={`${navigationScope}:${routine.id}`}
              title={routine.title}
              enabled={routine.enabled}
              canManage={canManage}
              disabled={disabled}
              className="routine-row detail-routine-row"
              onToggle={toggle}
              onEdit={() => open(routine.id, 'edit')}
              onDelete={() => open(routine.id, 'delete')}
            >
              <span className={`routine-icon ${routine.enabled ? '' : 'paused'}`}>
                <Clock3 size={14} />
              </span>
              <button
                type="button"
                className="routine-copy"
                disabled={disabled}
                onClick={() => open(routine.id)}
              >
                <span>{routine.title}</span>
                <small>
                  {routine.enabled
                    ? routineScheduleLabel(routine.schedule, routine.timeZone)
                    : uiText('routines:text_d817afe414e3', {
                        value0: routineScheduleLabel(routine.schedule, routine.timeZone),
                      })}
                </small>
              </button>
              {canManage && (
                <button
                  type="button"
                  role="switch"
                  disabled={disabled}
                  aria-label={`${uiText(routine.enabled ? 'workspace:text_8d12fc0d4eb2' : 'workspace:text_f4f0ead1116b')}${routine.title}`}
                  aria-checked={routine.enabled}
                  className={`detail-routine-switch ${routine.enabled ? 'on' : ''}`}
                  onClick={toggle}
                >
                  <span className={`toggle ${routine.enabled ? 'on' : ''}`}>
                    <span />
                  </span>
                </button>
              )}
            </RoutineActions>
          );
        })
      ) : canManage ? (
        <button className="add-detail-row" disabled={disabled} onClick={() => open(null)}>
          <Plus size={15} />
          {uiText('workspace:text_89425c3e4f23')}
        </button>
      ) : (
        <p className="section-help">{uiText('workspace:text_0fdbe80b8854')}</p>
      )}
    </section>
  );
}

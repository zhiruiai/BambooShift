import { uiText } from '../i18n';
import type { BotAgent, Conversation, Routine } from '../../../shared/types';
import type { RoutineRun } from '../../../shared/routine-runs';
import { routineScheduleLabel } from '../routineLabels';
import { routineNextRunLabel } from '../routineDraft';
import { displayTimeZone } from '../timeZones';
import { RoutineRunHistory } from './RoutineRunHistory';
import { Dialog } from './UI';
import './RoutineDialog.css';

export function RoutineOverview({
  routine,
  agents,
  conversations,
  showPublicSearch,
}: {
  routine: Routine;
  agents: BotAgent[];
  conversations: Conversation[];
  showPublicSearch?: boolean;
}) {
  return (
    <dl className="read-only-details routine-overview">
      <dt>{uiText('routines:text_68458e102038')}</dt>
      <dd>
        {agents.find((agent) => agent.id === routine.agentId)?.name ||
          uiText('routines:text_25536a7889ed')}
      </dd>
      <dt>{uiText('routines:text_5a7848eeebc9')}</dt>
      <dd>
        {conversations.find((chat) => chat.id === routine.conversationId)?.title ||
          uiText('routines:text_69c8e6de928f')}
      </dd>
      <dt>{uiText('routines:text_45e03e436ed0')}</dt>
      <dd>
        {routineScheduleLabel(routine.schedule, routine.timeZone)} ·{' '}
        {routine.enabled
          ? uiText('routines:text_dfb802238b38')
          : uiText('routines:text_eb0c326b60ae')}
      </dd>
      {routine.schedule !== 'webhook' && (
        <>
          <dt>{uiText('routines:text_ed1e866360d4')}</dt>
          <dd>{displayTimeZone(routine.timeZone)}</dd>
        </>
      )}
      <dt>{uiText('routines:text_c42e14d1b106')}</dt>
      <dd>{routineNextRunLabel(routine)}</dd>
      <dt>{uiText('routines:text_a8a2bb8a9ae8')}</dt>
      <dd className="routine-full-prompt">{routine.prompt}</dd>
      {showPublicSearch && !!routine.publicSearchQueries?.length && (
        <>
          <dt>{uiText('routines:publicSearchQueries')}</dt>
          <dd>{routine.publicSearchQueries.join('\n')}</dd>
        </>
      )}
    </dl>
  );
}

export function RoutineDetails(props: {
  routines: Routine[];
  agents: BotAgent[];
  conversations: Conversation[];
  initialRoutineId: string | null;
  workspaceId?: string;
  userId?: string;
  onOpenRun?: (run: RoutineRun) => void | Promise<void>;
  onClose: () => void;
}) {
  const visible = props.initialRoutineId
    ? props.routines.filter((r) => r.id === props.initialRoutineId)
    : props.routines;
  return (
    <Dialog
      title={uiText('routines:text_8983a65a2967')}
      subtitle={uiText('routines:text_1369b43a6315')}
      onClose={props.onClose}
    >
      {visible.length ? (
        visible.map((routine) => (
          <section className="readonly-routine" key={routine.id}>
            <h3>{routine.title}</h3>
            <RoutineOverview
              routine={routine}
              agents={props.agents}
              conversations={props.conversations}
            />
            <RoutineRunHistory
              key={`${props.userId}:${props.workspaceId}:${routine.id}`}
              routineId={routine.id}
              timeZone={routine.timeZone}
              workspaceId={props.workspaceId}
              userId={props.userId}
              refreshKey={routine.lastRunAt}
              onOpenRun={props.onOpenRun}
            />
          </section>
        ))
      ) : (
        <p className="section-help">{uiText('routines:text_1027b550e1c6')}</p>
      )}
    </Dialog>
  );
}

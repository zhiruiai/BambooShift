import { uiText } from '../../i18n';
import { BookOpen, Clock3 } from 'lucide-react';
import { routineScheduleLabel } from '../../components/RoutineDialog';
import { routineNextRunLabel } from '../../routineDraft';
import { skillStatusLabel } from '../../skillVersions';
import { AdminEmpty, AdminStatus, adminTime, Card } from './AdminPrimitives';
import { AdminPanelProps } from './types';
export function AutomationsPanel({
  data,
  overview,
  conversationId,
  onConversationChange,
  onRoutine,
  onSkill,
}: AdminPanelProps) {
  return (
    <>
      <div className="admin-page-heading">
        <h2>{uiText('platform:text_95a7b04b3216')}</h2>
        <p>{uiText('platform:text_e7eb6e7b640e')}</p>
      </div>
      <Card
        title={uiText('platform:text_8983a65a2967')}
        description={uiText('platform:text_96625625d789', {
          value0: overview.resources.enabledRoutines,
          value1: overview.deployment.schedulerEnabled
            ? uiText('platform:text_d350bcdecd97')
            : uiText('platform:text_41d4dc91292e'),
        })}
      >
        <div className="admin-section-tools">
          <label>
            {uiText('platform:text_a278d55a4898')}
            <select
              value={conversationId}
              onChange={(event) => onConversationChange(event.target.value)}
              disabled={!data.conversations.length}
            >
              {!data.conversations.length && (
                <option value="">{uiText('platform:text_69e71f0380ae')}</option>
              )}
              {data.conversations.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={!conversationId}
            onClick={() => onRoutine()}
          >
            <Clock3 size={14} />
            {uiText('platform:text_cec07531424d')}
          </button>
        </div>
        {data.routines.length ? (
          <div className="admin-list">
            {data.routines.map((routine) => (
              <div className="admin-row" key={routine.id}>
                <Clock3 size={20} />
                <div className="admin-row-copy">
                  <strong>{routine.title}</strong>
                  <small>{routineScheduleLabel(routine.schedule, routine.timeZone)}</small>
                  <small>
                    {data.agents.find((agent) => agent.id === routine.agentId)?.name ||
                      uiText('platform:text_0583e9855b7b')}{' '}
                    ·{' '}
                    {data.conversations.find((item) => item.id === routine.conversationId)?.title ||
                      uiText('platform:text_f7135e2baf61')}
                  </small>
                  <small>{routineNextRunLabel(routine)}</small>
                  {routine.lastRunAt && (
                    <small>
                      {uiText('platform:text_aaa0dcad523b')}
                      {adminTime(routine.lastRunAt)}
                    </small>
                  )}
                </div>
                <div className="admin-row-end">
                  <AdminStatus tone={routine.enabled ? '' : 'muted'}>
                    {routine.enabled
                      ? uiText('platform:text_dfb802238b38')
                      : uiText('platform:text_eb0c326b60ae')}
                  </AdminStatus>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onRoutine(routine)}
                  >
                    {uiText('platform:text_bb6d995724f4')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <AdminEmpty icon={<Clock3 size={24} />}>
            {uiText('platform:text_0d486f73f867')}
          </AdminEmpty>
        )}
      </Card>
      <Card
        title={uiText('platform:text_f8aa82c5ec40')}
        description={uiText('platform:text_c3fb6bbffb78', {
          value0: overview.resources.activeSkills,
          value1: overview.resources.pendingSkills,
          value2: data.skills.filter(
            (skill) => skill.status === 'archived' || skill.status === 'disabled',
          ).length,
        })}
      >
        {data.skills.length ? (
          <div className="admin-list">
            {[...data.skills]
              .sort(
                (left, right) =>
                  Number(right.status === 'proposed') - Number(left.status === 'proposed'),
              )
              .map((skill) => (
                <div className="admin-row" key={skill.id}>
                  <BookOpen size={20} />
                  <div className="admin-row-copy">
                    <strong>{skill.name}</strong>
                    <small>
                      {data.agents.find((agent) => agent.id === skill.agentId)?.name ||
                        uiText('platform:text_0583e9855b7b')}{' '}
                      {uiText('platform:text_1aec19ee9381')}
                      {skill.version}
                      {uiText('platform:text_f594f171672d')}
                    </small>
                    <p>{skill.description}</p>
                  </div>
                  <div className="admin-row-end">
                    <AdminStatus
                      tone={
                        skill.status === 'proposed'
                          ? 'waiting'
                          : skill.status === 'active'
                            ? ''
                            : 'muted'
                      }
                    >
                      {skillStatusLabel(skill.status)}
                    </AdminStatus>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onSkill(skill)}
                    >
                      {skill.status === 'proposed'
                        ? uiText('platform:text_b57ec49d159b')
                        : uiText('platform:text_393dd8a7f29e')}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <AdminEmpty icon={<BookOpen size={24} />}>
            {uiText('platform:text_66d178c4c5c7')}
          </AdminEmpty>
        )}
      </Card>
    </>
  );
}

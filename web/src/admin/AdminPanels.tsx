import { uiText } from '../i18n';
import {
  Activity,
  ArrowUpRight,
  Clock3,
  MessageCircle,
  Monitor,
  Sparkles,
  Users,
} from 'lucide-react';
import { bytes, Card } from './panels/AdminPrimitives';
import { RecordList } from './panels/RecordList';
import { RunningList } from './panels/RunningList';
import { AdminPanelProps } from './panels/types';
export { AccessPanel } from './panels/AccessPanel';
export { AdminEmpty, AdminStatus, adminTime } from './panels/AdminPrimitives';
export { AutomationsPanel } from './panels/AutomationsPanel';
export { BotsPanel } from './panels/BotsPanel';
export { ComputerPanel } from './panels/ComputerPanel';
export { ModelsPanel } from './panels/ModelsPanel';
export { RecordsPanel } from './panels/RecordsPanel';
export type { AdminPanelProps, AdminView } from './panels/types';
export function OverviewPanel(props: AdminPanelProps) {
  const { overview, onView, onModels, onComputer } = props;
  const { resources, execution, settings, computer } = overview;
  const stats = [
    {
      label: uiText('platform:text_4534bd2be65e'),
      value: resources.bots,
      detail: uiText('platform:text_ccc24d2453a8', { value0: resources.conversations }),
      icon: <Users size={18} />,
      view: 'bots',
    },
    {
      label: uiText('platform:text_c5c8c8903532'),
      value: execution.runningConversations.length,
      detail: uiText('platform:text_f3d106e5c04d'),
      icon: <Activity size={18} />,
      view: 'records',
    },
    {
      label: uiText('platform:text_f6bc7e8d1e42'),
      value: execution.queuedMessages,
      detail: uiText('platform:text_e236ca2bf35d'),
      icon: <MessageCircle size={18} />,
      view: 'records',
    },
    {
      label: uiText('platform:text_c1b643491b33'),
      value: resources.pendingSkills,
      detail: uiText('platform:text_111e04b1c882', { value0: resources.activeSkills }),
      icon: <Sparkles size={18} />,
      view: 'automations',
    },
  ] as const;
  return (
    <>
      <div className="admin-page-heading">
        <h2>{uiText('platform:text_1c24842110c3')}</h2>
        <p>{uiText('platform:text_bb11671d2562')}</p>
      </div>
      <div className="admin-stats">
        {stats.map((stat) => (
          <button
            type="button"
            className="admin-stat"
            key={stat.label}
            onClick={() => onView(stat.view)}
          >
            <span className="admin-stat-icon">{stat.icon}</span>
            <span className="admin-stat-label">{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.detail}</small>
          </button>
        ))}
      </div>
      <div className="admin-grid">
        <Card
          title={uiText('platform:text_055da4d50c7e')}
          description={uiText('platform:text_5270346417b9')}
        >
          <RunningList {...props} />
        </Card>
        <Card
          title={uiText('platform:text_7958d84e9a3f')}
          action={
            <button className="admin-plain-link" type="button" onClick={() => onView('computer')}>
              {uiText('platform:text_a748cc074f78')}
              <ArrowUpRight size={13} />
            </button>
          }
        >
          <div className="admin-list">
            <div className="admin-row">
              <Sparkles size={19} />
              <div className="admin-row-copy">
                <strong>{settings.profileName || settings.model}</strong>
                <small>{settings.model}</small>
              </div>
              <button className="secondary-button" type="button" onClick={onModels}>
                {uiText('platform:text_082a738ae620')}
              </button>
            </div>
            <div className="admin-row">
              <Monitor size={19} />
              <div className="admin-row-copy">
                <strong>{computer.name}</strong>
                <small>{computer.status}</small>
                <small>{uiText('platform:text_75a5a3ec660b')}</small>
              </div>
              <button className="secondary-button" type="button" onClick={onComputer}>
                {uiText('platform:text_a6b958240e18')}
              </button>
            </div>
            <div className="admin-row">
              <Clock3 size={19} />
              <div className="admin-row-copy">
                <strong>
                  {resources.enabledRoutines}
                  {uiText('platform:text_b6fcb094b59c')}
                </strong>
                <small>
                  {overview.deployment.schedulerEnabled
                    ? uiText('platform:text_314ba80e135f')
                    : uiText('platform:text_41d4dc91292e')}
                </small>
              </div>
              <button
                className="admin-plain-link"
                type="button"
                onClick={() => onView('automations')}
              >
                {uiText('platform:text_db8db0530432')}
                <ArrowUpRight size={13} />
              </button>
            </div>
          </div>
        </Card>
        <Card
          title={uiText('platform:text_58f15ed99277')}
          description={uiText('platform:text_571588b59c67')}
          action={
            <button className="admin-plain-link" type="button" onClick={() => onView('records')}>
              {uiText('platform:text_e42579208480')}
              <ArrowUpRight size={13} />
            </button>
          }
        >
          <RecordList
            records={execution.recentErrors.slice(0, 4)}
            empty={uiText('platform:text_196b43ad63cf')}
          />
        </Card>
        <Card
          title={uiText('platform:text_dea11d20f1d9')}
          description={uiText('platform:text_de0731361c0a')}
        >
          <dl className="admin-detail-grid">
            <div>
              <dt>{uiText('platform:text_a63280253f17')}</dt>
              <dd>
                {resources.conversations}
                <small>
                  {uiText('platform:text_328c51287da4')}
                  {resources.demoConversations}
                  {uiText('platform:text_422f464a653c')}
                </small>
              </dd>
            </div>
            <div>
              <dt>{uiText('platform:text_30b790cf21e9')}</dt>
              <dd>
                {resources.files}
                <small>
                  {uiText('platform:text_83a7b0e92223')}
                  {bytes(resources.fileBytes)}
                </small>
              </dd>
            </div>
            <div>
              <dt>{uiText('platform:text_7a6335b379b9')}</dt>
              <dd>
                {resources.memories}
                <small>{uiText('platform:text_61519a1b71f1')}</small>
              </dd>
            </div>
            <div>
              <dt>{uiText('platform:text_8983a65a2967')}</dt>
              <dd>
                {resources.routines}
                <small>
                  {resources.enabledRoutines}
                  {uiText('platform:text_7fc029a7559d')}
                </small>
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}

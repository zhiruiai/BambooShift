import { uiText } from '../../i18n';
import { Pause } from 'lucide-react';
import { Avatar, GroupAvatar } from '../../components/Avatar';
import { AdminEmpty, adminTime, ConversationLink } from './AdminPrimitives';
import { AdminPanelProps } from './types';
export function RunningList({ overview, data, busy, onStop, canStop }: AdminPanelProps) {
  const running = overview.execution.runningConversations;
  if (!running.length)
    return (
      <AdminEmpty detail={uiText('platform:text_cd8850010b3e')}>
        {uiText('platform:text_a6a3a6c88b13')}
      </AdminEmpty>
    );
  return (
    <div className="admin-list">
      {running.map((item) => {
        const agents = data.agents.filter((agent) => item.agentIds.includes(agent.id));
        return (
          <div className="admin-row" key={item.id}>
            {item.isGroup ? (
              <GroupAvatar agents={agents} size={39} />
            ) : (
              <Avatar agent={agents[0]} size={39} />
            )}
            <div className="admin-row-copy">
              <strong>{item.title}</strong>
              <small>
                {agents.map((agent) => agent.name).join(uiText('common:punct_c4a40ea8fe35')) ||
                  uiText('platform:text_a434aba665df')}
              </small>
              {item.startedAt && (
                <small>
                  {uiText('platform:text_cb3041c75409')}
                  {adminTime(item.startedAt)}
                </small>
              )}
            </div>
            <div className="admin-row-end">
              <ConversationLink id={item.id} />
              {canStop(item.id) ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => onStop(item.id)}
                >
                  <Pause size={13} />
                  {uiText('platform:text_aa69b1079f62')}
                </button>
              ) : (
                <small>{uiText('platform:text_bdce0ffcf9b2')}</small>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

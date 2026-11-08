import { uiText } from '../../i18n';
import { MessageCircle, Search, Users } from 'lucide-react';
import { useState } from 'react';
import { Avatar, GroupAvatar } from '../../components/Avatar';
import { AdminEmpty, AdminStatus, adminTime, Card, ConversationLink } from './AdminPrimitives';
import { AdminPanelProps } from './types';
export function BotsPanel({ data, overview }: AdminPanelProps) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLocaleLowerCase();
  const agents = data.agents.filter((agent) =>
    `${agent.name} ${agent.role} ${agent.description}`.toLocaleLowerCase().includes(normalized),
  );
  const conversations = data.conversations.filter((item) =>
    `${item.title} ${data.agents
      .filter((agent) => item.agentIds.includes(agent.id))
      .map((agent) => agent.name)
      .join(' ')}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
  const running = new Set(overview.execution.runningConversations.map((item) => item.id));
  return (
    <>
      <div className="admin-page-heading">
        <h2>{uiText('platform:text_f20171122e23')}</h2>
        <p>{uiText('platform:text_98289b337fb9')}</p>
      </div>
      <div className="admin-section-tools">
        <label>
          <Search size={16} />
          <input
            type="search"
            value={query}
            placeholder={uiText('platform:text_825bca3ae398')}
            aria-label={uiText('platform:text_a500e1ed0ea6')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <Card
        title={uiText('platform:text_4534bd2be65e')}
        description={uiText('platform:text_5894a99726f8', {
          value0: agents.length,
          value1: query ? uiText('platform:text_34ebf4d1941f') : '',
        })}
      >
        {agents.length ? (
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{uiText('platform:text_6ae62af4619f')}</th>
                  <th scope="col">{uiText('platform:text_6320b4a8722a')}</th>
                  <th scope="col">{uiText('platform:text_785deab4d37b')}</th>
                  <th scope="col">{uiText('platform:text_a63280253f17')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const conversation =
                    data.conversations.find(
                      (item) => !item.isGroup && item.agentIds.includes(agent.id),
                    ) || data.conversations.find((item) => item.agentIds.includes(agent.id));
                  return (
                    <tr key={agent.id}>
                      <td>
                        <div className="admin-row">
                          <Avatar agent={agent} size={38} />
                          <div className="admin-row-copy">
                            <strong>{agent.name}</strong>
                            <small>{agent.role}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <AdminStatus
                          tone={
                            agent.status === 'working'
                              ? 'working'
                              : agent.status === 'needs_input'
                                ? 'waiting'
                                : 'muted'
                          }
                        >
                          {
                            {
                              idle: uiText('platform:text_dae661d17c2d'),
                              working: uiText('platform:text_f42082263714'),
                              needs_input: uiText('platform:text_6569c6e69886'),
                            }[agent.status]
                          }
                        </AdminStatus>
                      </td>
                      <td>
                        {data.memories.filter((memory) => memory.agentId === agent.id).length}{' '}
                        {uiText('platform:text_09f1b3e38391')}{' '}
                        {
                          data.skills.filter(
                            (skill) => skill.agentId === agent.id && skill.status === 'active',
                          ).length
                        }{' '}
                        {uiText('platform:text_2e9d645f669e')}
                      </td>
                      <td>
                        {conversation ? (
                          <ConversationLink id={conversation.id} />
                        ) : (
                          uiText('platform:text_69e71f0380ae')
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <AdminEmpty icon={<Users size={24} />}>{uiText('platform:text_28382ebca5cd')}</AdminEmpty>
        )}
      </Card>
      <Card
        title={uiText('platform:text_19c6c208f94e')}
        description={uiText('platform:text_cb8997003d65', {
          value0: conversations.length,
          value1: query ? uiText('platform:text_34ebf4d1941f') : '',
        })}
      >
        {conversations.length ? (
          <div className="admin-list">
            {conversations.map((item) => {
              const members = data.agents.filter((agent) => item.agentIds.includes(agent.id));
              return (
                <div className="admin-row" key={item.id}>
                  {item.isGroup ? (
                    <GroupAvatar agents={members} size={39} />
                  ) : (
                    <Avatar agent={members[0]} size={39} />
                  )}
                  <div className="admin-row-copy">
                    <strong>
                      {item.title}
                      {item.demo && (
                        <span className="admin-count">{uiText('platform:text_0d53f08678d8')}</span>
                      )}
                    </strong>
                    <small>
                      {members
                        .map((agent) => agent.name)
                        .join(uiText('common:punct_c4a40ea8fe35')) ||
                        uiText('platform:text_c79314658372')}
                      {uiText('platform:text_41bb5c064d16')} {adminTime(item.updatedAt)}
                    </small>
                  </div>
                  <div className="admin-row-end">
                    {running.has(item.id) && (
                      <AdminStatus tone="working">
                        {uiText('platform:text_1f0eb99b7ed0')}
                      </AdminStatus>
                    )}
                    <ConversationLink id={item.id} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <AdminEmpty icon={<MessageCircle size={24} />}>
            {uiText('platform:text_f4fccb8cace5')}
          </AdminEmpty>
        )}
      </Card>
    </>
  );
}

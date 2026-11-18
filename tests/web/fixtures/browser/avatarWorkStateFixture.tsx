import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bootstrap, BotAgent, Message } from '../../../../shared/types';
import type { SidebarRosterController } from '../../../../web/src/useSidebarRoster';
import { activeAvatarMessageIds, conversationAvatarActivity } from '../../../../web/src/avatarActivity';
import { GroupAvatar } from '../../../../web/src/components/Avatar';
import { SidebarRosterList } from '../../../../web/src/components/SidebarRoster';
import { ChatMessageAvatar, ChatWorkingAvatar } from '../../../../web/src/workspace/ChatAvatar';
import { initializeAppearance } from '../../../../web/src/appearance';
import '../../../../web/src/styles-sections/01-base.css';

const bots: BotAgent[] = ['one', 'two', 'three', 'four'].map((id) => ({
  id,
  name: id,
  role: 'Synthetic checker',
  description: '',
  instructions: '',
  status: 'idle',
  avatar: 'orb',
  color: '#665577',
}));
const conversation = {
  id: 'chat',
  title: 'Synthetic task',
  isGroup: false,
  agentIds: ['four'],
  pinned: false,
  unread: 0,
  updatedAt: '2026-11-16T10:00:00Z',
};
const roster: SidebarRosterController = {
  state: { revision: 'synthetic', sections: [], entries: [] },
  busy: false,
  needsSync: false,
  error: '',
  read: async () => undefined,
  write: async () => ({ ok: false, review: false, message: '' }),
};
const actor = { isOwner: true, userId: 'owner' };
const base: Message = {
  id: 'work',
  role: 'assistant',
  agentId: 'four',
  conversationId: 'chat',
  content: '',
  status: 'running',
  createdAt: '2026-11-16T10:00:00Z',
};
initializeAppearance().update({ avatarTheme: 'colorful', useCustomAvatarTheme: false });

function Fixture() {
  const [scene, setScene] = useState('thinking');
  const working = !['completed', 'failed', 'history'].includes(scene);
  const message: Message =
    scene === 'thinking'
      ? base
      : scene === 'finishing'
        ? { ...base, content: 'Checking the last result.', metadata: { streamEnded: true } }
        : {
            ...base,
            kind: 'computer',
            status: 'done',
            metadata: {
              action: {
                id: 'script',
                type: 'local_shell',
                payload: { command: 'printf synthetic' },
                requester: { userId: 'owner' },
                status: ['approval', 'automatic'].includes(scene)
                  ? 'pending'
                  : ['completed', 'failed', 'new-run'].includes(scene)
                    ? 'done'
                    : 'running',
                ...(scene === 'automatic'
                  ? {
                      authorization: {
                        mode: 'full',
                        scope: 'current-user-current-computer',
                        grantedAt: '2026-11-16T10:00:00Z',
                      },
                    }
                  : {}),
                result: { exitCode: scene === 'failed' ? 7 : 0 },
              },
            },
          };
  const stale: Message = {
    ...base,
    id: 'old-running',
    agentId: 'one',
    kind: 'computer',
    metadata: {
      action: {
        id: 'old-script',
        type: 'local_shell',
        payload: { command: 'printf stale' },
        status: 'running',
      },
    },
  };
  const messages: Message[] = ['new-run', 'queued-followup'].includes(scene)
    ? [
        {
          ...message,
          id: 'old',
          agentId: 'one',
          metadata: {
            action: {
              id: 'old-request',
              type: 'local_shell',
              payload: { command: 'printf old' },
              status: 'pending',
            },
          },
        },
        stale,
        {
          ...base,
          id: 'new-user',
          role: 'user',
          agentId: undefined,
          content: 'A new task',
          status: 'done',
          ...(scene === 'queued-followup'
            ? { delivery: { state: 'queued', mode: 'followUp', agentId: 'four' } as const }
            : {}),
        },
        message,
      ]
    : [message];
  if (scene === 'queued-followup')
    messages.push({
      ...base,
      id: 'follow-up',
      role: 'user',
      agentId: undefined,
      content: 'Do this next',
      status: 'done',
      delivery: { state: 'queued', mode: 'followUp', agentId: 'one' },
    });
  const requests =
    scene === 'queued-followup'
      ? [{ conversationId: 'chat', requester: { userId: 'owner', messageId: 'new-user' } }]
      : undefined;
  const active = activeAvatarMessageIds(messages, requests);
  const activity = conversationAvatarActivity(messages, working, actor, requests);
  const data = {
    agents: bots,
    conversations: [conversation],
    messages,
    runningRequests: requests,
    primaryBot: {
      available: true,
      agentId: 'four',
      conversationId: 'chat',
      checkIn: { enabled: false, time: '09:00' },
    },
    sidebarRoster: roster.state,
  } as unknown as Bootstrap;
  return (
    <main>
      <nav>
        {[
          'thinking',
          'working',
          'finishing',
          'new-run',
          'queued-followup',
          'approval',
          'automatic',
          'completed',
          'failed',
          'history',
        ].map((value) => (
          <button key={value} onClick={() => setScene(value)}>
            {value}
          </button>
        ))}
      </nav>
      <section id="sidebar">
        <SidebarRosterList
          data={data}
          roster={roster}
          query=""
          mobile={false}
          selected="chat"
          now={0}
          working={() => working}
          onOpen={() => {}}
          onDialog={() => {}}
          onPrimary={() => {}}
          onNotice={() => {}}
        />
      </section>
      <section id="message">
        <ChatMessageAvatar
          message={message}
          agent={bots[3]}
          actor={actor}
          streaming={false}
          active={working && active.has(message.id)}
          grouped={false}
        />
      </section>
      {messages.includes(stale) && (
        <section id="history">
          <ChatMessageAvatar
            message={stale}
            agent={bots[0]}
            actor={actor}
            streaming={false}
            active={working && active.has(stale.id)}
            grouped={false}
          />
        </section>
      )}
      <section id="indicator">
        {working && <ChatWorkingAvatar agent={bots[3]} actor={actor} last={message} />}
      </section>
      <section id="group">
        <GroupAvatar
          agents={bots}
          activeAgentId={activity.agentId}
          motion={activity.motion}
          sustain={working}
        />
      </section>
      <output>
        {activity.agentId}:{activity.motion}
      </output>
    </main>
  );
}
createRoot(document.getElementById('fixture')!).render(<Fixture />);

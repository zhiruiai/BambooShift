import { useMemo, useRef, useState, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { BotAgent, Conversation, Message } from '../../../shared/types';
import { createAppConnectionScope } from '../appConnections';
import type { BotProfileDraft } from '../botProfiles';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { CreateDialog } from '../components/CreateDialog';
import { initializeLanguage } from '../i18n';
import { useAppearance } from '../useAppearance';
import { ChatMessages } from '../workspace/ChatMessages';
import { currentWorkspaceId } from '../workspace-scope';
import '../styles.css';
import '../theme.css';

const workspaceId = currentWorkspaceId()!;
const mount = document.getElementById('fixture')!;
const scene = mount.dataset.surface;
const ownerId = 'synthetic-owner';
const profile = {
  name: 'Chat planning Bot',
  role: 'Planner',
  description: 'Organize the synthetic work.',
  instructions: 'Review plans with the owner.',
  avatar: 'leaf',
  color: '#335577',
  avatarImageId: null,
} as const;
const agent: BotAgent = { ...profile, id: 'synthetic-bot', status: 'idle' };
const clockNow = Date.parse('2026-11-07T12:00:10Z');
const conversation: Conversation = {
  id: 'synthetic-dm',
  title: agent.name,
  agentIds: [agent.id],
  isGroup: false,
  unread: 0,
  pinned: false,
  updatedAt: new Date(clockNow).toISOString(),
};

function message(id: string, fields: Partial<Message>): Message {
  return {
    id,
    agentId: agent.id,
    conversationId: conversation.id,
    role: 'assistant',
    kind: 'text',
    content: '',
    status: 'done',
    createdAt: new Date(clockNow).toISOString(),
    ...fields,
  };
}

const messages = [
  message('preamble', {
    content: 'I am drafting two options.',
    status: 'running',
    metadata: { streamEnded: true },
  }),
  message('bot-draft', {
    kind: 'creation_preview',
    content: profile.name,
    metadata: { creationPreview: { kind: 'bot', profile } },
  }),
  message('theme-draft', {
    kind: 'creation_preview',
    content: 'Chat comet theme',
    metadata: {
      creationPreview: {
        kind: 'theme',
        theme: {
          name: 'Chat comet theme',
          motif: 'chicks',
          colors: ['#aabbcc', '#224455', '#889911'],
          badge: 'star',
          backdrop: 'solid',
        },
      },
    },
  }),
];
const noOp = () => {};
type ChatProps = ComponentProps<typeof ChatMessages>;

function Fixture() {
  const [dialog, setDialog] = useState(scene === 'bot');
  const [draft, setDraft] = useState<BotProfileDraft>();
  const [stage, setStage] = useState(0);
  const [owner, setOwner] = useState(true);
  const userId = owner ? ownerId : 'synthetic-member';
  const scope = useMemo(() => createAppConnectionScope({ workspaceId, userId }), [userId]);
  const appearance = useAppearance();
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  return (
    <main style={{ maxWidth: 750, margin: '20px auto', padding: 16 }}>
      {scene === 'theme' && (
        <AppearanceSettings generation={{ workspaceId, userId, configured: true }} />
      )}
      {scene === 'chat' && (
        <>
          <button onClick={() => setStage((current) => current + 1)}>Advance synthetic run</button>
          <button onClick={() => setOwner(!owner)}>
            {owner ? 'View as member' : 'View as owner'}
          </button>
          <ChatMessages
            scrollRef={scrollRef}
            nearBottom={nearBottom}
            setUnreadBelow={noOp}
            conversation={conversation}
            sidebar={{ total: 1, visible: [] } as unknown as ChatProps['sidebar']}
            openRoster={noOp}
            data={{ agents: [agent], conversations: [conversation] } as ChatProps['data']}
            openPrimary={noOp}
            messages={[
              ...messages,
              message('tail', {
                status: stage < 2 ? 'running' : 'done',
                content: stage === 0 ? '' : 'The two drafts are ready to review.',
              }),
            ]}
            lead={agent}
            setDraft={noOp}
            composerRef={composerRef}
            clockNow={clockNow}
            highlightedMessage=""
            ownMessage={(value) => value.userId === userId}
            userName={() => 'Synthetic owner'}
            appearance={appearance}
            jumpToMessage={noOp}
            canManage={owner}
            openTemplates={noOp}
            navigateTemplatePage={noOp}
            navigationScope={`${workspaceId}:${userId}`}
            account={null}
            currentUserId={userId}
            openCreate={(_plan, mode, profile) => {
              if (mode !== 'bot' || !profile) throw new Error('Missing draft handoff');
              setDraft(profile);
              setDialog(true);
            }}
            acceptConfirmedTeam={noOp}
            openConversation={noOp}
            sync={{ written: noOp } as ChatProps['sync']}
            refresh={async () => {}}
            openApps={noOp}
            openAppProposal={noOp}
            openComputer={noOp}
            copy={async () => {}}
            beginReply={noOp}
            reactionPicker={null}
            setReactionPicker={noOp}
            reactionPending={new Set()}
            reactToMessage={async () => {}}
            sendScope={scope as ChatProps['sendScope']}
            modal={dialog ? 'create' : null}
            working={stage < 2}
            currentWorker={agent}
            voice={{ state: { supported: false, voices: [] } } as unknown as ChatProps['voice']}
          />
        </>
      )}
      {dialog && (
        <CreateDialog
          agents={[agent]}
          canCreateBot={owner}
          initialMode="bot"
          initialProfile={draft}
          modelConfigured
          workspaceId={workspaceId}
          userId={userId}
          onClose={() => setDialog(false)}
          onCreated={() => {
            throw new Error('The fixture must not create a Bot');
          }}
        />
      )}
    </main>
  );
}

initializeLanguage().setLanguage('en');
const root = createRoot(mount);
flushSync(() => root.render(<Fixture />));

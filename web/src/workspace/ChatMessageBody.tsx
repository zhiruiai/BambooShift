import { ChatQuestionCard } from '../components/chatQuestions/ChatQuestionCard';
import { parseChatQuestion } from '../../../shared/chat-questions';
import { fixedWorkspaceApi } from '../fixedWorkspaceApi';
import { AppConnectionProposalCard } from '../components/AppConnectionProposalCard';
import { canReviewCustomApp } from '../appProposalEntry';
import { parseAppConnectionProposal } from '../../../shared/app-proposals';
import { parseBotTemplateCard } from '../botTemplates';
import { AppActionCard, parseAppAction } from '../components/AppActionCard';
import { BotTeamProposalCard, parseBotTeamProposal } from '../components/BotTeamProposalCard';
import { BotTemplateCard } from '../components/BotTemplateCard';
import { ComputerCard } from '../components/ChatComputerCard';
import { CreationDraftCard } from '../components/CreationDraftCard';
import { FileCard } from '../components/FileCard';
import { Markdown } from '../components/Markdown';
import { MessageAppContext } from '../components/MessageExtras';
import { WebsiteProjectCard } from '../components/WebsiteProjectCard';
import { VoiceMemoCard } from '../components/VoiceMemoCard';
import { currentWorkspaceId, workspaceApiUrl } from '../workspace-scope';
import type { BotAgent, Message } from '../../../shared/types';
import { uiText } from '../i18n';
import type { OpenWebsiteProject } from '../websiteProjects';
import { messageVoiceMemo } from '../voiceMemo';
import type { WorkspaceModel } from './types';

type MessageBodyActions = Pick<
  WorkspaceModel,
  | 'account'
  | 'canManage'
  | 'conversation'
  | 'currentUserId'
  | 'data'
  | 'voice'
  | 'modal'
  | 'navigationScope'
  | 'openCreate'
  | 'openAppProposal'
  | 'openTemplates'
  | 'navigateTemplatePage'
  | 'acceptConfirmedTeam'
  | 'openConversation'
  | 'openApps'
  | 'openComputer'
  | 'sendScope'
  | 'sync'
  | 'refresh'
>;

export function ChatMessageBody({
  message: m,
  agentName,
  liveAgent,
  streaming,
  current,
  actions,
  openWebsiteProject,
}: {
  message: Message;
  agentName?: string;
  liveAgent?: BotAgent;
  streaming: boolean;
  current: () => boolean;
  actions: MessageBodyActions;
  openWebsiteProject?: OpenWebsiteProject;
}) {
  const {
    account,
    canManage,
    conversation,
    currentUserId,
    data,
    navigationScope,
    openCreate,
    openAppProposal,
    openTemplates,
    navigateTemplatePage,
    acceptConfirmedTeam,
    openConversation,
    openApps,
    openComputer,
    sendScope,
    sync,
    refresh,
  } = actions;
  const memo = messageVoiceMemo(m, data.files);
  const question =
    m.kind === 'question' && m.role === 'assistant' && m.status === 'done' && m.agentId
      ? parseChatQuestion(m.metadata?.question)
      : undefined;
  return (
    <>
      {question ? (
        <ChatQuestionCard
          key={`${navigationScope}:${m.id}:${question.runId}`}
          message={m}
          question={question}
          userId={currentUserId}
          localTargetAvailable={
            conversation?.id === m.conversationId &&
            !conversation.demo &&
            !!liveAgent &&
            !liveAgent.sharedBot &&
            conversation.agentIds.includes(liveAgent.id)
          }
          current={current}
          request={fixedWorkspaceApi(sendScope)}
          onConfirmed={() => {
            sync.written();
            void refresh();
          }}
        />
      ) : m.kind === 'website_project' ? (
        <WebsiteProjectCard message={m} onOpen={openWebsiteProject} />
      ) : m.kind === 'creation_preview' ? (
        <CreationDraftCard
          message={m}
          owner={canManage}
          current={current}
          onProfile={(profile) => openCreate(undefined, 'bot', profile)}
        />
      ) : parseAppConnectionProposal(m) ? (
        <AppConnectionProposalCard
          message={m}
          owner={canManage}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          localBotAvailable={!!liveAgent && !liveAgent.sharedBot}
          customScope={
            account?.workspace.kind === 'personal' &&
            !!m.agentId &&
            canReviewCustomApp(conversation, m.agentId)
          }
          apps={data.apps}
          current={current}
          onOpen={openAppProposal}
        />
      ) : m.role === 'assistant' && parseBotTemplateCard(m.metadata?.botTemplate) ? (
        <BotTemplateCard
          card={parseBotTemplateCard(m.metadata?.botTemplate)!}
          owner={canManage}
          onManage={(templateId) => openTemplates({ kind: 'manage', templateId })}
          onOpenPublic={navigateTemplatePage}
        />
      ) : m.role === 'assistant' && parseBotTeamProposal(m.metadata?.teamProposal) ? (
        <BotTeamProposalCard
          key={`${navigationScope}:${m.id}`}
          proposal={parseBotTeamProposal(m.metadata?.teamProposal)!}
          sourceName={agentName || uiText('workspace:text_0583e9855b7b')}
          sourceRemoved={!!m.agentId && !liveAgent}
          owner={canManage}
          scopeKey={navigationScope}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          canOpenConversation={data.conversations.some(
            (item) =>
              item.id === parseBotTeamProposal(m.metadata?.teamProposal)?.result?.conversationId,
          )}
          onOpenPlan={openCreate}
          onOpenConversation={(confirmed) => {
            acceptConfirmedTeam(confirmed);
            openConversation(confirmed.conversation);
          }}
        />
      ) : m.kind === 'approval' && parseAppAction(m.metadata?.appAction) ? (
        <AppActionCard
          action={parseAppAction(m.metadata?.appAction)!}
          owner={canManage}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          onChanged={async () => {
            sync.written();
            await refresh();
          }}
          onApps={openApps}
        />
      ) : m.kind === 'computer' ? (
        <ComputerCard
          message={m}
          owner={canManage}
          userId={currentUserId}
          demo={!!conversation?.demo && !m.metadata?.action}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          onChanged={async () => {
            sync.written();
            await refresh();
          }}
          onClick={() => openComputer(m.agentId || null)}
        />
      ) : memo ? (
        <VoiceMemoCard
          memo={memo}
          scope={navigationScope}
          identity={{
            userId: currentUserId,
            workspaceId: account?.workspace.id,
            pathname: window.location.pathname,
          }}
          current={current}
          blocked={!!actions.modal || actions.voice.blocked}
          speakingId={actions.voice.state.speakingId}
          stopReading={actions.voice.stopReading}
        />
      ) : m.kind === 'file' ? (
        <div className="message-bubble">
          <Markdown text={m.content} />
          <FileCard
            name={String(m.metadata?.name || m.content || uiText('workspace:text_554ca52e0660'))}
            size={Number(m.metadata?.size || 0)}
            href={
              m.metadata?.fileId
                ? workspaceApiUrl(`/api/files/${m.metadata.fileId}/download`)
                : undefined
            }
          />
        </div>
      ) : (
        <div
          className={`message-bubble ${m.status === 'error' ? 'message-error' : ''}`}
          aria-busy={streaming || undefined}
        >
          <Markdown text={m.content || ' '} />
          <MessageAppContext message={m} />
          {streaming && <span className="typing-cursor" aria-hidden="true" />}
        </div>
      )}
    </>
  );
}

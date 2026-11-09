import { uiText } from '../i18n';
import { ChatMentionStatus } from '../components/ChatMentionStatus';
import { Check, Info, MessageSquare } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import type { Message } from '../../../shared/types';
import { ChatMessageAvatar, ChatWorkingAvatar } from './ChatAvatar';
import { MessageActions, type MessagePopup } from '../components/MessageActions';
import { MessageActivity } from '../components/MessageActivity';
import { DeliveryNotice, MessageReactions, QuotedMessage } from '../components/MessageExtras';
import { PrimaryBotIntroduction } from '../components/PrimaryBotEntry';
import { HiddenRosterEmpty } from '../components/SidebarRoster';
import type { OpenWebsiteProject } from '../websiteProjects';
import { calendarLabel, messageTime as time } from '../dates';
import { chatTimeline } from '../chatTimeline';
import { historicalAuthor, removedAuthor } from '../messageAuthors';
import type { WorkspaceModel } from './types';
import { ChatMessageBody } from './ChatMessageBody';
import { ChatStarter } from './ChatStarter';
import { WebResearchCard } from '../components/WebResearchCard';
import { VoiceCallCard } from '../components/VoiceCallControls';
import './ChatMessages.css';

export function ChatMessages({
  scrollRef,
  nearBottom,
  setUnreadBelow,
  conversation,
  sidebar,
  openRoster,
  data,
  openPrimary,
  messages,
  lead,
  setDraft,
  composerRef,
  clockNow,
  highlightedMessage,
  ownMessage,
  userName,
  appearance,
  jumpToMessage,
  canManage,
  openTemplates,
  navigateTemplatePage,
  navigationScope,
  account,
  currentUserId,
  openCreate,
  acceptConfirmedTeam,
  openConversation,
  sync,
  refresh,
  openApps,
  openAppProposal,
  openComputer,
  copy,
  beginReply,
  reactionPicker,
  setReactionPicker,
  reactionPending,
  reactToMessage,
  sendScope,
  modal,
  working,
  timelineWorking = working,
  currentWorker,
  voice,
  openWebsiteProject,
  threadRoot,
  threadReplies,
  openThread,
}: Pick<
  WorkspaceModel,
  | 'scrollRef'
  | 'nearBottom'
  | 'setUnreadBelow'
  | 'conversation'
  | 'sidebar'
  | 'openRoster'
  | 'data'
  | 'openPrimary'
  | 'messages'
  | 'lead'
  | 'setDraft'
  | 'composerRef'
  | 'clockNow'
  | 'highlightedMessage'
  | 'ownMessage'
  | 'userName'
  | 'appearance'
  | 'jumpToMessage'
  | 'canManage'
  | 'openTemplates'
  | 'navigateTemplatePage'
  | 'navigationScope'
  | 'account'
  | 'currentUserId'
  | 'openCreate'
  | 'acceptConfirmedTeam'
  | 'openConversation'
  | 'sync'
  | 'refresh'
  | 'openApps'
  | 'openAppProposal'
  | 'openComputer'
  | 'copy'
  | 'beginReply'
  | 'reactionPicker'
  | 'setReactionPicker'
  | 'reactionPending'
  | 'reactToMessage'
  | 'sendScope'
  | 'modal'
  | 'working'
  | 'currentWorker'
  | 'voice'
> & {
  openWebsiteProject?: OpenWebsiteProject;
  threadRoot?: Message;
  threadReplies?: ReadonlyMap<string, number>;
  openThread?: (message: Message) => void;
  timelineWorking?: boolean;
}) {
  const scope = `${navigationScope}:${conversation?.id || ''}:${threadRoot?.id || ''}`;
  const timeline = useMemo(
    () => chatTimeline(messages, timelineWorking),
    [messages, timelineWorking],
  );
  const actor = { userId: currentUserId, isOwner: canManage };
  const agentsById = useMemo(
    () => new Map(data.agents.map((agent) => [agent.id, agent])),
    [data.agents],
  );
  const bodyActions = {
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
    modal,
    voice,
  };
  const [more, setMore] = useState<{ id: string; scope: string } | null>(null);
  const ticket = sendScope.ticket();
  const surface = useRef({ scope, modal });
  surface.current = { scope, modal };
  const current = () =>
    surface.current.scope === scope && !surface.current.modal && sendScope.current(ticket);
  useEffect(() => {
    setMore((old) => (old?.scope !== scope || modal ? null : old));
    if (modal) setReactionPicker(null);
  }, [scope, modal, setReactionPicker]);
  function showPopup(id: string, popup: MessagePopup | null) {
    if (!current()) return;
    setMore((old) => (popup === 'more' ? { id, scope } : old?.id === id || popup ? null : old));
    setReactionPicker((old) => (popup === 'reactions' ? id : old === id || popup ? null : old));
  }

  function openContext(event: MouseEvent<HTMLElement>, id: string) {
    if (event.defaultPrevented || !current()) return;
    if (
      (event.target as Element).closest?.(
        'a,button,summary,input,textarea,select,[contenteditable]',
      ) ||
      window.getSelection()?.toString()
    )
      return;
    event.preventDefault();
    showPopup(id, 'more');
  }

  function actions(message: Message) {
    const collaborative = message.role !== 'system' && message.kind !== 'activity';
    return (
      <MessageActions
        key={`${scope}:${message.id}`}
        message={message}
        currentUserId={currentUserId}
        current={current}
        voice={voice}
        popup={
          modal
            ? null
            : more?.scope === scope && more.id === message.id
              ? 'more'
              : reactionPicker === message.id
                ? 'reactions'
                : null
        }
        onPopup={(value) => showPopup(message.id, value)}
        busy={reactionPending.has(message.id)}
        onReact={
          collaborative ? (emoji, active) => void reactToMessage(message, emoji, active) : undefined
        }
        onReply={collaborative ? () => beginReply(message) : undefined}
        onThread={
          collaborative && !threadRoot && openThread ? () => openThread(message) : undefined
        }
        onJump={
          message.replyTo && message.replyTo.id !== threadRoot?.id
            ? () => jumpToMessage(message.conversationId, message.replyTo?.id)
            : undefined
        }
        copy={copy}
      />
    );
  }

  return (
    <>
      <div
        className="messages-scroll"
        aria-label={threadRoot ? uiText('workspace:threadTitle') : undefined}
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current!;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          if (nearBottom.current) setUnreadBelow(false);
        }}
      >
        {conversation?.demo && !threadRoot && (
          <div className="conversation-start">
            <span>{uiText('workspace:text_883d20aab406')}</span>
          </div>
        )}
        <div className="message-stack">
          {!conversation && sidebar.total > 0 && sidebar.visible.length === 0 ? (
            <HiddenRosterEmpty onOpen={() => openRoster({ kind: 'hidden' })} />
          ) : !conversation && data.primaryBot?.available && !data.primaryBot.agentId ? (
            <PrimaryBotIntroduction onManage={openPrimary} />
          ) : timeline.rows.length === 0 && !timelineWorking ? (
            <ChatStarter
              lead={lead}
              choose={(prompt) => {
                setDraft(prompt);
                composerRef.current?.focus();
              }}
            />
          ) : (
            timeline.rows.map(
              ({
                message: m,
                webResearch,
                startsDay,
                groupedWithPrevious,
                groupedWithNext,
                streaming,
              }) => {
                const liveAgent = m.agentId ? agentsById.get(m.agentId) : undefined;
                const agent =
                  liveAgent || historicalAuthor(m) || (m.agentId ? removedAuthor(m.agentId) : lead);
                const dateDivider = startsDay ? (
                  <div className="message-date-divider">{calendarLabel(m.createdAt, clockNow)}</div>
                ) : null;
                const highlight = highlightedMessage === m.id ? 'message-highlighted' : '';
                const replyCount = !threadRoot ? threadReplies?.get(m.id) || 0 : 0;
                if (webResearch)
                  return (
                    <Fragment key={m.id}>
                      {dateDivider}
                      <article
                        id={`message-${m.id}`}
                        tabIndex={-1}
                        className={`message-row incoming activity-row ${highlight}`}
                      >
                        <div className="message-content">
                          <WebResearchCard key={scope} research={webResearch} />
                        </div>
                      </article>
                    </Fragment>
                  );
                if (m.kind === 'activity')
                  return (
                    <Fragment key={m.id}>
                      {dateDivider}
                      <article
                        id={`message-${m.id}`}
                        tabIndex={-1}
                        className={`message-row incoming activity-row ${highlight}`}
                        onContextMenu={(event) => openContext(event, m.id)}
                      >
                        <div className="message-content">
                          <MessageActivity
                            message={m}
                            agents={data.agents}
                            targetName={agent?.name}
                          />
                          <div className="message-footer compact-message-footer">{actions(m)}</div>
                        </div>
                      </article>
                    </Fragment>
                  );
                if (m.kind === 'voice_call')
                  return (
                    <Fragment key={m.id}>
                      {dateDivider}
                      <article
                        id={`message-${m.id}`}
                        tabIndex={-1}
                        className={`message-row incoming activity-row ${highlight}`}
                      >
                        <div className="message-content">
                          <VoiceCallCard
                            message={m}
                            messages={messages}
                            voice={voice}
                            current={current}
                            speaker={(turn) =>
                              turn.role === 'user'
                                ? userName(turn)
                                : agent?.name || uiText('workspace:voiceCallBot')
                            }
                          />
                        </div>
                      </article>
                    </Fragment>
                  );
                if (m.role === 'system')
                  return (
                    <Fragment key={m.id}>
                      {dateDivider}
                      <div
                        id={`message-${m.id}`}
                        tabIndex={-1}
                        className={`system-message ${highlight}`}
                        onContextMenu={(event) => openContext(event, m.id)}
                      >
                        <Info size={12} />
                        <span>{m.content}</span>
                        {actions(m)}
                      </div>
                    </Fragment>
                  );
                return (
                  <Fragment key={m.id}>
                    {dateDivider}
                    <article
                      id={`message-${m.id}`}
                      tabIndex={-1}
                      className={`message-row ${m.role === 'user' && ownMessage(m) ? 'outgoing' : 'incoming'} ${groupedWithNext ? 'message-row-linked' : ''} ${highlight}`}
                      onContextMenu={(event) => openContext(event, m.id)}
                    >
                      <ChatMessageAvatar
                        key={scope}
                        message={m}
                        agent={agent}
                        actor={actor}
                        streaming={streaming}
                        grouped={groupedWithNext}
                        teammate={m.role === 'user' && !ownMessage(m) ? userName(m) : undefined}
                      />
                      <div
                        className="message-content"
                        data-bot-accent={
                          m.role === 'assistant' &&
                          conversation &&
                          !conversation.isGroup &&
                          conversation.agentIds.length === 1
                            ? appearance.accent
                            : undefined
                        }
                        style={
                          m.role === 'assistant' &&
                          conversation &&
                          !conversation.isGroup &&
                          conversation.agentIds.length === 1 &&
                          /^#[\da-f]{6}$/i.test(agent?.color || '')
                            ? ({ '--message-bot-color': agent!.color } as CSSProperties)
                            : undefined
                        }
                      >
                        {!groupedWithPrevious && m.role === 'user' && !ownMessage(m) && (
                          <div className="message-author">{userName(m)}</div>
                        )}
                        {!groupedWithPrevious &&
                          m.role === 'assistant' &&
                          conversation?.isGroup && (
                            <div className="message-author" style={{ color: agent?.color }}>
                              {agent?.name}
                              {m.agentId && !liveAgent && (
                                <span className="removed-author">
                                  {uiText('workspace:text_174688c755b9')}
                                </span>
                              )}
                            </div>
                          )}
                        {m.role === 'assistant' &&
                          !!m.metadata?.primaryCheckIn &&
                          typeof m.metadata.primaryCheckIn === 'object' && (
                            <div className="primary-checkin-badge">
                              {uiText('workspace:text_8b384ad11885')}
                            </div>
                          )}
                        {m.replyTo && m.replyTo.id !== threadRoot?.id && (
                          <QuotedMessage
                            quote={m.replyTo}
                            onJump={() => jumpToMessage(m.conversationId, m.replyTo!.id)}
                          />
                        )}
                        <ChatMessageBody
                          message={m}
                          agentName={agent?.name}
                          liveAgent={liveAgent}
                          streaming={streaming}
                          current={current}
                          actions={bodyActions}
                          openWebsiteProject={openWebsiteProject}
                        />
                        <ChatMentionStatus message={m} agents={data.agents} />
                        {!m.mentions && m.delivery && m.delivery.state !== 'delivered' && (
                          <DeliveryNotice
                            delivery={m.delivery}
                            agentName={data.agents.find((a) => a.id === m.delivery?.agentId)?.name}
                          />
                        )}
                        <MessageReactions
                          currentUserId={currentUserId}
                          message={m}
                          busy={reactionPending.has(m.id)}
                          onReact={(emoji, active) => {
                            if (current()) void reactToMessage(m, emoji, active);
                          }}
                        />
                        {replyCount > 0 && openThread && (
                          <button
                            className="thread-reply-count"
                            type="button"
                            onClick={() => openThread(m)}
                          >
                            <MessageSquare size={14} aria-hidden="true" />
                            {replyCount === 1
                              ? uiText('workspace:threadOneReply')
                              : uiText('workspace:threadReplyCount', { count: replyCount })}
                          </button>
                        )}
                        <div
                          className={`message-footer ${groupedWithNext || streaming ? 'compact-message-footer' : ''}`}
                        >
                          {!groupedWithNext && !streaming && (
                            <div className="message-time">
                              <time dateTime={m.createdAt}>{time(m.createdAt)}</time>
                              {!m.mentions && m.delivery?.state === 'delivered' && (
                                <DeliveryNotice
                                  compact
                                  delivery={m.delivery}
                                  agentName={
                                    data.agents.find((a) => a.id === m.delivery?.agentId)?.name
                                  }
                                />
                              )}
                              {m.role === 'user' && !m.delivery && (
                                <Check
                                  size={12}
                                  aria-label={uiText('workspace:text_1bd91a7d0c53')}
                                />
                              )}
                            </div>
                          )}
                          {actions(m)}
                        </div>
                      </div>
                    </article>
                  </Fragment>
                );
              },
            )
          )}
        </div>
        {timeline.showWorking && (
          <ChatWorkingAvatar
            agent={currentWorker}
            last={timeline.rows.at(-1)?.message}
            actor={actor}
          />
        )}
        <div className="scroll-padding" />
      </div>
    </>
  );
}

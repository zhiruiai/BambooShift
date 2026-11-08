import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { isSharedBot } from '../../../shared/shared-bots';
import { type ComposerState } from '../chatDrafts';
import { groupMentionsUnavailable, removeMention } from '../composerMentions';
import { ComposerInput, type ComposerInputProps } from './ComposerInput';
import { DictationButton, DictationStatus } from '../components/DictationControls';
import { VoiceControls } from '../components/VoiceControls';
import { VoiceCallStart } from '../components/VoiceCallControls';
import { VoiceMemoRequest, VoiceMemoSelection } from '../components/VoiceMemoRequest';
import type { WorkspaceVoiceCall } from '../useVoiceCall';
import { ComposerReply } from '../components/MessageExtras';
import { IconButton } from '../components/UI';
import type { WorkspaceModel } from './types';

export function ChatComposer(
  props: Pick<
    WorkspaceModel,
    | 'conversation'
    | 'account'
    | 'unreadBelow'
    | 'setHighlightedMessage'
    | 'scrollRef'
    | 'nearBottom'
    | 'setUnreadBelow'
    | 'data'
    | 'canManage'
    | 'openSettings'
    | 'lead'
    | 'sharedUnavailable'
    | 'replyTo'
    | 'jumpToMessage'
    | 'selected'
    | 'composerKey'
    | 'threadRootId'
    | 'timelineWorking'
    | 'updateComposer'
    | 'sendErrors'
    | 'sending'
    | 'dictation'
    | 'voice'
    | 'submitAttempt'
    | 'setSendErrors'
    | 'receipts'
    | 'refresh'
    | 'working'
    | 'deliveryMode'
    | 'attachments'
    | 'setAttachments'
    | 'currentComposer'
    | 'members'
    | 'send'
    | 'uploading'
    | 'fileRef'
    | 'draft'
    | 'toggleDictation'
    | 'canStop'
    | 'busy'
    | 'stopCurrentTask'
    | 'upload'
  > &
    ComposerInputProps & { voiceCall?: WorkspaceVoiceCall; voiceCallPanel?: React.ReactNode },
) {
  const {
    conversation,
    unreadBelow,
    setHighlightedMessage,
    scrollRef,
    nearBottom,
    setUnreadBelow,
    data,
    canManage,
    openSettings,
    lead,
    sharedUnavailable,
    replyTo,
    jumpToMessage,
    selected,
    composerKey = selected,
    threadRootId,
    updateComposer,
    sendErrors,
    sending,
    dictation,
    voice,
    submitAttempt,
    setSendErrors,
    receipts,
    refresh,
    working,
    timelineWorking = working,
    deliveryMode,
    attachments,
    setAttachments,
    currentComposer,
    members,
    send,
    uploading,
    fileRef,
    draft,
    toggleDictation,
    canStop,
    busy,
    stopCurrentTask,
    upload,
  } = props;
  const appContext = currentComposer.appContext;
  const mentions = currentComposer.mentions;
  const voiceMemoRequested = currentComposer.requestVoiceMemo === true;
  const voiceMemoEligible =
    data.voiceMemo?.available === true &&
    props.account?.workspace.kind === 'personal' &&
    props.account.workspace.role === 'owner' &&
    !!conversation &&
    !conversation.demo &&
    !conversation.isGroup &&
    conversation.agentIds.length === 1 &&
    !!lead &&
    !isSharedBot(lead) &&
    !threadRootId &&
    !replyTo &&
    !currentComposer.agentId &&
    !appContext &&
    !mentions &&
    !props.voiceCall?.active;
  const requesterMessage = data.runningRequests?.find(
    (run) => run.conversationId === selected && run.threadRootId === threadRootId,
  )?.requester?.messageId;
  const separateTask =
    !!appContext ||
    !!mentions ||
    (!!requesterMessage &&
      data.messages?.some(
        (message) => message.id === requesterMessage && (message.appContext || message.mentions),
      ));
  const appUnavailable =
    !!appContext &&
    (members.some((agent) => isSharedBot(agent)) ||
      !data.apps?.some(
        (app) =>
          app.id === appContext.connectionId &&
          app.revision === appContext.revision &&
          app.status === 'connected' &&
          app.toolCount > 0,
      ));
  const mentionsUnavailable = groupMentionsUnavailable(
    mentions,
    conversation?.isGroup === true,
    members,
  );
  const canSubmit =
    !appUnavailable && !mentionsUnavailable && (!voiceMemoRequested || voiceMemoEligible);
  const audience = mentions
    ? 'everyone' in mentions
      ? [undefined]
      : mentions.agentIds
    : currentComposer.agentId
      ? [currentComposer.agentId]
      : [];
  return (
    <>
      {conversation && (
        <div className="composer-area">
          {unreadBelow && (
            <button
              className="jump-bottom"
              onClick={() => {
                setHighlightedMessage('');
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: 'smooth',
                });
                nearBottom.current = true;
                setUnreadBelow(false);
              }}
            >
              <ArrowDown size={16} />
              {uiText('workspace:text_d34db9bc67fb')}
            </button>
          )}
          {!data.settings.configured &&
            (canManage ? (
              <button className="setup-note" onClick={() => openSettings('models')}>
                <span>
                  <Sparkles size={13} />
                  {uiText('workspace:text_ba6c7c10cd66')}
                </span>
                <span>
                  {uiText('workspace:text_df3d58c7d84b')}
                  <ChevronRight size={12} />
                </span>
              </button>
            ) : (
              <div className="setup-note">
                <span>
                  <Sparkles size={13} />
                  {uiText('workspace:text_4464defc411d')}
                </span>
              </div>
            ))}
          {!conversation?.isGroup && isSharedBot(lead) && (
            <div className="shared-bot-banner" role="status">
              <strong>
                {uiText('workspace:text_fd4e0ab45e27')}
                {lead?.sharedBot?.ownerName || uiText('workspace:text_440712bdcd33')}
              </strong>
              <br />
              {sharedUnavailable
                ? serviceText(lead?.sharedBot?.reason) || uiText('workspace:text_7ed478b22f8c')
                : uiText('workspace:text_652067e42c7c')}
            </div>
          )}
          {replyTo && (
            <ComposerReply
              quote={replyTo}
              onJump={() => jumpToMessage(selected, replyTo.id)}
              onCancel={() =>
                updateComposer(composerKey, (current) => ({ ...current, replyTo: undefined }))
              }
            />
          )}
          {sendErrors[composerKey] && (
            <div className="send-error" role="status">
              <div>
                <strong>
                  {sendErrors[composerKey].uncertain
                    ? uiText('workspace:text_5715ca6da3c7')
                    : uiText('workspace:text_c1221250747a')}
                </strong>
                <span>{sendErrors[composerKey].message}</span>
                <small>{sendErrors[composerKey].attempt.content.slice(0, 100)}</small>
              </div>
              <button
                type="button"
                disabled={sending.has(selected) || dictation.busy || sharedUnavailable}
                onClick={() => void submitAttempt(sendErrors[composerKey].attempt)}
              >
                {uiText('workspace:text_fcff8ee2ea11')}
              </button>
              <button
                type="button"
                aria-label={uiText('workspace:text_9940f9452014')}
                onClick={() =>
                  setSendErrors((current) => {
                    const next = { ...current };
                    delete next[composerKey];
                    return next;
                  })
                }
              >
                <X size={14} />
              </button>
            </div>
          )}
          {!sendErrors[composerKey] &&
            !sending.has(selected) &&
            receipts.pending(selected, threadRootId) > 0 && (
              <div className="send-error" role="status">
                <div>
                  <strong>{uiText('workspace:text_d158d1543e4d')}</strong>
                  <span>{uiText('workspace:text_17ea97b6d838')}</span>
                  {!receipts.persistent && <small>{uiText('workspace:text_d005ea844b77')}</small>}
                </div>
                <button type="button" onClick={() => void refresh()}>
                  {uiText('workspace:text_97b345716642')}
                </button>
              </div>
            )}
          {timelineWorking && !separateTask && !voiceMemoRequested && (
            <div className="composer-delivery-mode">
              <select
                aria-label={uiText('workspace:text_709fc1bb462c')}
                title={uiText(
                  deliveryMode === 'steer'
                    ? 'workspace:text_a34ace33848c'
                    : 'workspace:text_b9bfd2f532c7',
                )}
                value={deliveryMode}
                onChange={(event) =>
                  updateComposer(composerKey, (current) => ({
                    ...current,
                    mode: event.target.value as ComposerState['mode'],
                  }))
                }
              >
                <option value="steer">{uiText('workspace:text_594ccbc91ad4')}</option>
                <option value="followUp">{uiText('workspace:text_6197a82566df')}</option>
              </select>
            </div>
          )}
          {appContext && (
            <div className="attachment-tray" role="status">
              <span title={uiText('workspace:composerAppHelp')}>
                {uiText('workspace:composerAppSelected', { name: appContext.name })}
                <button
                  type="button"
                  aria-label={uiText('workspace:composerAppRemove', { name: appContext.name })}
                  onClick={() =>
                    updateComposer(composerKey, (current) => ({
                      ...current,
                      appContext: undefined,
                    }))
                  }
                >
                  <X size={13} />
                </button>
              </span>
              {appUnavailable && <small>{uiText('workspace:composerAppUnavailable')}</small>}
            </div>
          )}
          {working && (!timelineWorking || separateTask) && canSubmit && !voiceMemoRequested && (
            <div className="composer-delivery-mode" role="status">
              {uiText(
                !timelineWorking || mentions
                  ? 'workspace:threadSeparateTask'
                  : 'workspace:composerAppQueued',
              )}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="attachment-tray">
              {attachments.map((f) => (
                <span key={f.id}>
                  <FileText size={14} />
                  {f.name}
                  <button
                    aria-label={uiText('workspace:text_b33022909d64', { value0: f.name })}
                    onClick={() => setAttachments((a) => a.filter((x) => x.id !== f.id))}
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {!!audience.length && (
            <div className="attachment-tray" role="status">
              {audience.map((id) => {
                const name = id ? members.find((agent) => agent.id === id)?.name : 'everyone';
                const label = name ? `@${name}` : uiText('workspace:text_9260b658c908');
                return (
                  <span key={id ?? 'everyone'}>
                    {label}
                    <button
                      type="button"
                      aria-label={uiText('workspace:composerMentionRemove', { name: label })}
                      onClick={() =>
                        updateComposer(composerKey, (draft) => removeMention(draft, id, name))
                      }
                    >
                      <X size={13} />
                    </button>
                  </span>
                );
              })}
              {mentionsUnavailable && (
                <small>{uiText('workspace:composerMentionUnavailable')}</small>
              )}
            </div>
          )}
          <DictationStatus
            state={dictation.state}
            onFinish={dictation.finish}
            onCancel={dictation.cancel}
            onDismiss={dictation.dismiss}
            onCheck={dictation.retryStatus}
          />
          {props.voiceCallPanel}
          {voiceMemoRequested && (
            <VoiceMemoSelection eligible={voiceMemoEligible} queued={working} />
          )}
          <form
            className="composer composer-with-voice"
            onSubmit={(event) => {
              if (canSubmit) void send(event);
              else event.preventDefault();
            }}
          >
            <IconButton
              label={uiText('workspace:text_c8a47d001848')}
              disabled={uploading.has(selected)}
              onClick={() => fileRef.current?.click()}
            >
              <Plus size={22} />
            </IconButton>
            <ComposerInput
              key={composerKey}
              {...props}
              send={(event) => (canSubmit ? send(event) : Promise.resolve())}
              toggleDictation={() => {
                if (props.voiceCall?.active) return;
                voice.stopReading();
                toggleDictation();
              }}
            />
            <div className="composer-actions">
              <DictationButton
                state={dictation.state}
                disabled={
                  !conversation ||
                  sending.has(selected) ||
                  uploading.has(selected) ||
                  !!props.voiceCall?.active
                }
                onToggle={() => {
                  voice.stopReading();
                  toggleDictation();
                }}
              />
              {props.voiceCall && <VoiceCallStart key={selected} call={props.voiceCall} />}
              {(voiceMemoEligible || voiceMemoRequested) && (
                <VoiceMemoRequest
                  active={voiceMemoRequested}
                  disabled={sending.has(selected)}
                  onChange={() =>
                    updateComposer(composerKey, (current) => ({
                      ...current,
                      requestVoiceMemo: current.requestVoiceMemo ? undefined : true,
                    }))
                  }
                />
              )}
              {!threadRootId && !props.voiceCall?.active && (
                <VoiceControls
                  key={`${selected}:${currentComposer.agentId || conversation?.agentIds[0] || ''}`}
                  voice={voice}
                  blocked={dictation.busy}
                  onStop={() => {
                    voice.stop();
                    dictation.cancel();
                  }}
                />
              )}
              {canStop && timelineWorking && (
                <IconButton
                  label={uiText('workspace:text_aa69b1079f62')}
                  className="stop-button"
                  disabled={busy}
                  onClick={() => {
                    voice.stop();
                    dictation.cancel();
                    void stopCurrentTask();
                  }}
                >
                  <Square size={13} fill="currentColor" />
                </IconButton>
              )}
              <button
                type="submit"
                aria-label={uiText('workspace:text_008814832cf7')}
                title={uiText('workspace:text_008814832cf7')}
                className="send-button"
                disabled={
                  sharedUnavailable ||
                  !canSubmit ||
                  sending.has(selected) ||
                  dictation.busy ||
                  uploading.has(selected) ||
                  (!draft.trim() && !attachments.length)
                }
              >
                {sending.has(selected) || uploading.has(selected) ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <ArrowUp size={18} />
                )}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => void upload(e.target.files)}
            />
          </form>
          <div className="composer-footnote">
            <span>{uiText('workspace:text_c08324e8ffe1')}</span>
            <span>{uiText('workspace:text_8d5d9a2365aa')}</span>
          </div>
        </div>
      )}
    </>
  );
}

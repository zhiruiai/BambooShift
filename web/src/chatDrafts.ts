import { uiText } from './i18n';
import type { Message, WorkspaceFile } from '../../shared/types';
import type { ChatAppContext, ChatAppSelection } from '../../shared/app-connections';
import type { ChatMentions } from '../../shared/chat-mentions';
import { workspaceApiUrl } from './workspace-scope';
export type ComposerState = {
  text: string;
  attachments: WorkspaceFile[];
  replyTo?: Message['replyTo'];
  mode: 'steer' | 'followUp';
  agentId?: string;
  appContext?: ChatAppContext;
  skillId?: string;
  mentions?: ChatMentions;
  requestVoiceMemo?: true;
};
export type SendAttempt = {
  conversationId: string;
  clientId: string;
  content: string;
  replyToMessageId?: string;
  threadRootId?: string;
  mode: 'steer' | 'followUp';
  agentId?: string;
  appContext?: ChatAppSelection;
  skillId?: string;
  mentions?: ChatMentions;
  requestVoiceMemo?: true;
  snapshot: ComposerState;
};
export function emptyComposer(): ComposerState {
  return { text: '', attachments: [], mode: 'steer' };
}
export const composerScopeKey = (conversationId: string, threadRootId?: string) =>
  threadRootId ? JSON.stringify([conversationId, threadRootId]) : conversationId;
export function composerContent(draft: ComposerState): string {
  return [
    draft.text.trim(),
    ...draft.attachments.map((file) =>
      uiText('common:text_28a86dedcd3b', {
        value0: file.name,
        value1: workspaceApiUrl(`/api/files/${file.id}/download`),
      }),
    ),
  ]
    .filter(Boolean)
    .join('\n');
}
function submissionMode(draft: ComposerState): ComposerState['mode'] {
  return draft.requestVoiceMemo || draft.skillId ? 'followUp' : draft.mode;
}

export function submissionKey(draft: ComposerState, threadRootId?: string): string {
  // Preserve the previous fingerprint for ordinary drafts so their saved
  // receipt IDs remain recoverable after upgrading the client.
  const mode = submissionMode(draft);
  const fields = [composerContent(draft), draft.replyTo?.id || threadRootId || '', mode];
  if (draft.agentId !== undefined) fields.push(draft.agentId);
  if (
    !threadRootId &&
    !draft.appContext &&
    !draft.skillId &&
    !draft.mentions &&
    !draft.requestVoiceMemo
  )
    return JSON.stringify(fields);
  return JSON.stringify({
    fields,
    ...(threadRootId ? { threadRootId } : {}),
    ...(draft.mentions ? { mentions: draft.mentions } : {}),
    ...(draft.requestVoiceMemo ? { requestVoiceMemo: true } : {}),
    ...(draft.skillId ? { skillId: draft.skillId } : {}),
    ...(draft.appContext
      ? { app: [draft.appContext.connectionId, draft.appContext.revision] }
      : {}),
  });
}
export const sameAppSelection = (left?: ChatAppSelection, right?: ChatAppSelection) =>
  left?.connectionId === right?.connectionId && left?.revision === right?.revision;
export function makeSendAttempt(
  conversationId: string,
  draft: ComposerState,
  previous?: SendAttempt,
  threadRootId?: string,
): SendAttempt {
  if (
    previous?.conversationId === conversationId &&
    previous.threadRootId === threadRootId &&
    submissionKey(previous.snapshot, threadRootId) === submissionKey(draft, threadRootId)
  )
    return previous.snapshot === draft ? previous : { ...previous, snapshot: draft };
  return {
    conversationId,
    clientId: crypto.randomUUID(),
    content: composerContent(draft),
    replyToMessageId: draft.replyTo?.id || threadRootId,
    ...(threadRootId ? { threadRootId } : {}),
    mode: submissionMode(draft),
    ...(draft.requestVoiceMemo ? { requestVoiceMemo: true } : {}),
    ...(draft.skillId ? { skillId: draft.skillId } : {}),
    ...(draft.agentId !== undefined ? { agentId: draft.agentId } : {}),
    ...(draft.mentions
      ? {
          mentions:
            'everyone' in draft.mentions
              ? { everyone: true }
              : { agentIds: [...draft.mentions.agentIds] },
        }
      : {}),
    ...(draft.appContext
      ? {
          appContext: {
            connectionId: draft.appContext.connectionId,
            revision: draft.appContext.revision,
          },
        }
      : {}),
    snapshot: draft,
  };
}
export function clearSubmittedDraft(
  current: ComposerState,
  snapshot: ComposerState,
): ComposerState {
  if (current !== snapshot) return current;
  const {
    agentId: _agentId,
    appContext: _appContext,
    skillId: _skillId,
    mentions: _mentions,
    requestVoiceMemo: _requestVoiceMemo,
    ...remaining
  } = current;
  return { ...remaining, text: '', attachments: [], replyTo: undefined };
}

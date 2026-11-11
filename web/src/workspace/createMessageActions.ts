import { type FormEvent } from 'react';
import type { Message } from '../../../shared/types';
import { matchesChatMentionReceipt } from '../../../shared/chat-mentions';
import { ApiError } from '../api';
import { uiText } from '../i18n';
import {
  clearSubmittedDraft,
  composerContent,
  composerScopeKey,
  makeSendAttempt,
  type SendAttempt,
} from '../chatDrafts';
import type { MessageActionsContext } from './createMessageActions.types';
export function createMessageActions(read: () => MessageActionsContext) {
  const api: import('../fixedWorkspaceApi').FixedWorkspaceApi = (path, method, body) =>
    read().api(path, method, body);
  function upsertMessage(message: Message, reactionsOnly = false) {
    const { setData } = read();

    setData((current) =>
      current
        ? {
            ...current,
            messages: current.messages.some((m) => m.id === message.id)
              ? current.messages.map((m) =>
                  m.id === message.id && reactionsOnly
                    ? {
                        ...m,
                        reactions: message.reactions,
                        reactionMembers: message.reactionMembers,
                      }
                    : m,
                )
              : [...current.messages, message],
          }
        : current,
    );
  }
  async function reactToMessage(message: Message, emoji: string, active: boolean) {
    const {
      reactionRef,
      setReactionPending,
      sync,
      setReactionPicker,
      refresh,
      setToast,
      sendScope,
    } = read();
    const ticket = sendScope.ticket();
    if (!sendScope.current(ticket)) return;

    if (reactionRef.current.has(message.id)) return;
    reactionRef.current.add(message.id);
    setReactionPending(new Set(reactionRef.current));
    try {
      const result = await api<Message>(`/messages/${message.id}/reactions`, 'POST', {
        emoji,
        active,
      });
      if (!sendScope.current(ticket)) return;
      sync.written();
      upsertMessage(result, true);
      setReactionPicker((current) => (current === message.id ? null : current));
      await refresh();
    } catch (error) {
      if (sendScope.current(ticket)) setToast((error as Error).message);
    } finally {
      reactionRef.current.delete(message.id);
      if (sendScope.current(ticket)) setReactionPending(new Set(reactionRef.current));
    }
  }
  function settleAttempt(attempt: SendAttempt) {
    const {
      attempts,
      setSendErrors,
      setComposers,
      selectedRef,
      composerKeyRef,
      nearBottom,
      jumpRef,
      setPendingJump,
      setHighlightedMessage,
    } = read();

    const target = composerScopeKey(attempt.conversationId, attempt.threadRootId);
    if (attempts.current.get(target)?.clientId === attempt.clientId)
      attempts.current.delete(target);
    setSendErrors((errors) => {
      if (errors[target]?.attempt.clientId !== attempt.clientId) return errors;
      const next = { ...errors };
      delete next[target];
      return next;
    });
    setComposers((all) => {
      const current = all[target];
      return current ? { ...all, [target]: clearSubmittedDraft(current, attempt.snapshot) } : all;
    });
    if ((composerKeyRef?.current ?? selectedRef.current) === target) {
      nearBottom.current = true;
      jumpRef.current = null;
      setPendingJump(null);
      setHighlightedMessage('');
    }
  }
  function reconcileReceipts(messages: Message[]) {
    const { receipts, setReceiptCount } = read();

    for (const message of messages) {
      const confirmed = receipts.confirm(message);
      if (confirmed) settleAttempt(confirmed);
    }
    setReceiptCount(receipts.pending());
  }
  async function submitAttempt(original: SendAttempt) {
    const {
      sendScope,
      sendingRef,
      selected,
      dictation,
      setSending,
      receipts,
      attempts,
      setReceiptCount,
      sync,
      refresh,
      setSendErrors,
      selectedRef,
      composerKeyRef,
      modalRef,
      composerRef,
    } = read();

    const target = original.conversationId,
      key = composerScopeKey(target, original.threadRootId),
      ticket = sendScope.ticket();
    const current = () => sendScope.current(ticket);
    if (!current() || sendingRef.current.has(target) || (target === selected && dictation.busy))
      return;
    sendingRef.current.add(target);
    setSending(new Set(sendingRef.current));
    let attempt = original,
      posted = false;
    try {
      attempt = await receipts.prepare(original);
      if (!current()) return;
      attempts.current.set(key, attempt);
      setReceiptCount(receipts.pending());
      if (!receipts.wasConfirmed(attempt)) {
        posted = true;
        const { message } = await sendScope.request<{ message: Message }>(
          `/conversations/${encodeURIComponent(target)}/messages`,
          'POST',
          {
            content: attempt.content,
            replyToMessageId: attempt.replyToMessageId,
            ...(attempt.threadRootId ? { threadRootId: attempt.threadRootId } : {}),
            agentId: attempt.agentId,
            ...(attempt.mentions ? { mentions: attempt.mentions } : {}),
            ...(attempt.appContext ? { appContext: attempt.appContext } : {}),
            ...(attempt.skillId ? { skillId: attempt.skillId } : {}),
            ...(attempt.requestVoiceMemo ? { requestVoiceMemo: true } : {}),
            mode: attempt.mode,
            clientId: attempt.clientId,
          },
        );
        if (!current()) return;
        if (!matchesChatMentionReceipt(attempt.mentions, message.mentions))
          throw new Error(uiText('workspace:composerMentionUnknown'));
        if (attempt.skillId !== message.skillId)
          throw new Error(uiText('workspace:composerSkillUnknown'));
        if (Boolean(attempt.requestVoiceMemo) !== (message.metadata?.requestVoiceMemo === true))
          throw new Error(uiText('workspace:voiceMemoReceiptUnknown'));
        sync.written();
        upsertMessage(message);
        reconcileReceipts([message]);
      }
      if (!current()) return;
      settleAttempt(attempt);
      await refresh();
    } catch (error) {
      if (!current()) return;
      if (receipts.wasConfirmed(attempt)) {
        // A stream receipt can arrive before a failed/lost HTTP response.
        settleAttempt(attempt);
      } else {
        const rejected =
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408;
        if (rejected) receipts.reject(attempt);
        setSendErrors((errors) => ({
          ...errors,
          [key]: {
            message:
              error instanceof ApiError && error.code === 'THREAD_CONTEXT_UNAVAILABLE'
                ? uiText('workspace:threadUnavailable')
                : error instanceof ApiError && error.code?.startsWith('CHAT_MENTION')
                  ? uiText('workspace:composerMentionUnavailable')
                  : error instanceof ApiError && error.code?.startsWith('VOICE_MEMO')
                    ? uiText('workspace:voiceMemoRequestUnavailable')
                    : error instanceof ApiError && error.code === 'SKILL_CONTEXT_UNAVAILABLE'
                      ? uiText('workspace:composerSkillUnavailable')
                      : (error as Error).message,
            attempt,
            uncertain: posted && !rejected,
          },
        }));
      }
      setReceiptCount(receipts.pending());
      if (posted) void refresh();
    } finally {
      sendingRef.current.delete(target);
      if (!current()) return;
      setSending(new Set(sendingRef.current));
      if ((composerKeyRef?.current ?? selectedRef.current) === key && !modalRef.current)
        composerRef.current?.focus();
    }
  }
  async function send(e?: FormEvent) {
    const {
      conversation,
      dictation,
      compositionRef,
      pendingDictation,
      sendingRef,
      selected,
      composerKey = selected,
      threadRootId,
      uploadingRef,
      currentComposer,
      attempts,
    } = read();

    e?.preventDefault();
    if (
      !conversation ||
      dictation.busy ||
      compositionRef.current ||
      !!pendingDictation.current ||
      sendingRef.current.has(selected) ||
      uploadingRef.current.has(selected) ||
      !composerContent(currentComposer)
    )
      return;
    const attempt = makeSendAttempt(
      selected,
      currentComposer,
      attempts.current.get(composerKey),
      threadRootId,
    );
    attempts.current.set(composerKey, attempt);
    await submitAttempt(attempt);
  }
  return { upsertMessage, reactToMessage, settleAttempt, reconcileReceipts, submitAttempt, send };
}

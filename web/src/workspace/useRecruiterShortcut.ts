import { useEffect, useRef, useState } from 'react';
import type { BotAgent, Conversation } from '../../../shared/types';
import type { ComposerState } from '../chatDrafts';
import { currentLanguage, uiText } from '../i18n';
import type { WorkspaceModel } from './types';

export type RecruiterShortcut = {
  pending: boolean;
  open: (brief: string) => Promise<void>;
};

type RecruiterModel = Pick<
  WorkspaceModel,
  | 'api'
  | 'canManage'
  | 'composerKey'
  | 'composerKeyRef'
  | 'conversation'
  | 'currentComposer'
  | 'modal'
  | 'navigationScope'
  | 'openConversation'
  | 'refresh'
  | 'selected'
  | 'selectedRef'
  | 'sendScope'
  | 'setData'
  | 'setModal'
  | 'setToast'
  | 'sync'
  | 'threadRootId'
  | 'updateComposer'
>;

type RecruiterResult = {
  agentId: string;
  conversationId: string;
  agent: BotAgent;
  conversation: Conversation;
};

function recruiterResult(value: RecruiterResult | null) {
  if (
    !value ||
    typeof value.agentId !== 'string' ||
    !value.agentId ||
    typeof value.conversationId !== 'string' ||
    !value.conversationId ||
    value.agent?.id !== value.agentId ||
    value.agent.sharedBot ||
    typeof value.agent.name !== 'string' ||
    typeof value.agent.role !== 'string' ||
    value.conversation?.id !== value.conversationId ||
    typeof value.conversation.title !== 'string' ||
    value.conversation.isGroup !== false ||
    value.conversation.demo ||
    !Array.isArray(value.conversation.agentIds) ||
    value.conversation.agentIds.length !== 1 ||
    value.conversation.agentIds[0] !== value.agentId
  )
    throw new Error('Invalid recruiter response');
  return value;
}

function plainDraft(draft: ComposerState) {
  return (
    !draft.attachments.length &&
    !draft.replyTo &&
    !draft.appContext &&
    !draft.skillId &&
    !draft.mentions &&
    !draft.requestVoiceMemo
  );
}

export function useRecruiterShortcut({
  model,
  blocked = false,
  entry = 'composer',
}: {
  model: RecruiterModel;
  blocked?: boolean;
  entry?: 'composer' | 'create';
}): RecruiterShortcut | undefined {
  const key = JSON.stringify([model.navigationScope, model.composerKey, entry]);
  const allowed =
    !blocked &&
    model.canManage &&
    (entry === 'create'
      ? model.modal === 'create'
      : !model.modal && !!model.conversation && !model.conversation.demo);
  const latest = useRef({ model, key, allowed, source: {} });
  const source =
    latest.current.key === key &&
    latest.current.allowed === allowed &&
    latest.current.model.sendScope === model.sendScope
      ? latest.current.source
      : {};
  latest.current = { model, key, allowed, source };
  const active = useRef(true);
  const inProgress = useRef<object | undefined>(undefined);
  const [pending, setPending] = useState<object>();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      inProgress.current = undefined;
    };
  }, []);

  async function open(brief: string) {
    const ticket = model.sendScope.ticket();
    const current = () =>
      active.current &&
      latest.current.allowed &&
      latest.current.source === source &&
      model.sendScope.current(ticket) &&
      model.selectedRef.current === model.selected &&
      model.composerKeyRef.current === model.composerKey;
    if (!current() || inProgress.current === source) return;
    inProgress.current = source;
    setPending(source);
    const failure = uiText('workspace:composerRecruiterFailed');
    model.setToast((previous) => (previous === failure ? '' : previous));
    try {
      const { agent, conversation } = recruiterResult(
        await model.api<RecruiterResult | null>('/recruiter', 'POST', {
          locale: currentLanguage(),
        }),
      );
      if (!current()) return;
      const live = latest.current.model;
      live.sync.written();
      live.setData((previous) =>
        previous && model.sendScope.current(ticket)
          ? {
              ...previous,
              agents: [...previous.agents.filter((entry) => entry.id !== agent.id), agent],
              conversations: [
                ...previous.conversations.filter((entry) => entry.id !== conversation.id),
                conversation,
              ],
            }
          : previous,
      );
      const text = brief.trim();
      if (
        text &&
        entry === 'composer' &&
        !model.threadRootId &&
        conversation.id !== model.selected &&
        live.currentComposer === model.currentComposer &&
        plainDraft(model.currentComposer)
      )
        live.updateComposer(conversation.id, (previous) =>
          model.sendScope.current(ticket) && !previous.text && plainDraft(previous)
            ? { ...previous, text }
            : previous,
        );
      live.openConversation(conversation);
      if (entry === 'create') live.setModal(null);
      void live.refresh();
    } catch {
      if (current()) latest.current.model.setToast(failure);
    } finally {
      if (inProgress.current === source) {
        inProgress.current = undefined;
        if (active.current) setPending(undefined);
      }
    }
  }

  return allowed ? { pending: pending === source, open } : undefined;
}

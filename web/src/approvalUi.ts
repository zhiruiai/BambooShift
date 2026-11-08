import { uiText } from './i18n';
import {
  canDecideAction,
  parseActionRequester,
  type ActionRequester,
  type ApprovalActor,
} from '../../shared/approvals';

export function approvalPendingLabel(requester: unknown, userId?: string) {
  if (requester === undefined) return uiText('common:text_cb8f770cf8a2');
  const person = parseActionRequester(requester);
  if (!person) return uiText('common:text_ce9efcbab200');
  return person.userId === userId
    ? uiText('common:text_f8e43091f661')
    : uiText('common:text_9814c33c1478', {
        value0: person.name || uiText('common:text_07c8087580f5'),
      });
}

export function approvalHelp(requester: unknown, userId?: string) {
  if (requester === undefined) return uiText('common:text_1b99cdab66e4');
  const person = parseActionRequester(requester);
  if (!person) return uiText('common:text_df1fe7b23c5c');
  return person.userId === userId
    ? uiText('common:text_fd6a2e0a7729')
    : uiText('common:text_0bf57fd7438b', {
        value0: person.name || uiText('common:text_b0f5eb18a569'),
      });
}

export function conversationVisibility(kind?: string) {
  return kind === 'team'
    ? uiText('common:text_c161962b0f5f')
    : kind === 'personal'
      ? uiText('common:text_e4e924464d58')
      : uiText('common:text_ecee28508f0b');
}

export function canStopConversation(
  requests: Array<{ conversationId: string; requester?: ActionRequester }> | undefined,
  conversationId: string,
  actor: ApprovalActor,
) {
  if (requests === undefined) return actor.isOwner;
  const matching = requests.filter((request) => request.conversationId === conversationId);
  return matching.length === 1 && canDecideAction(matching[0].requester, actor);
}

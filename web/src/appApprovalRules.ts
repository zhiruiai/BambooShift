import type {
  AppAction,
  AppApprovalRule,
  ExactAppApprovalInput,
  InteractiveAppApproval,
} from '../../shared/app-connections';
import { SHARED_BOT_ID } from '../../shared/shared-bots';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 512;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && SHARED_BOT_ID.test(value);
const githubOwner = /^[A-Za-z0-9-]{1,39}$/;
const githubRepository = /^[A-Za-z0-9_.-]{1,100}$/;

export function exactAppApprovalInput(value: unknown): ExactAppApprovalInput | undefined {
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    value.method !== 'get' ||
    typeof value.owner !== 'string' ||
    !githubOwner.test(value.owner) ||
    typeof value.repo !== 'string' ||
    !githubRepository.test(value.repo) ||
    value.repo === '.' ||
    value.repo === '..' ||
    typeof value.issue_number !== 'number' ||
    !Number.isSafeInteger(value.issue_number) ||
    value.issue_number < 1 ||
    value.issue_number > 2_147_483_647
  )
    return;
  const { method, owner, repo, issue_number } = value;
  return { method, owner, repo, issue_number };
}

export function interactiveAppApproval(value: unknown): InteractiveAppApproval | undefined {
  if (
    !object(value) ||
    typeof value.eligible !== 'boolean' ||
    !label(value.agentName) ||
    !label(value.conversationTitle) ||
    (value.ruleId !== undefined && !uuid(value.ruleId)) ||
    (value.usage !== undefined && value.usage !== 'saved' && value.usage !== 'reused') ||
    (value.usage !== undefined && value.ruleId === undefined)
  )
    return;
  const { eligible, agentName, conversationTitle, ruleId, usage } = value;
  return { eligible, agentName, conversationTitle, ruleId, usage };
}

export type ExactApprovalScope = Pick<
  AppApprovalRule,
  'agentName' | 'conversationTitle' | 'connectionName' | 'toolName' | 'input'
>;

export function appApprovalReview(action: AppAction, actor: { userId?: string; owner: boolean }) {
  const approval = interactiveAppApproval(action.interactiveApproval);
  const input = exactAppApprovalInput(action.arguments);
  if (
    !actor.owner ||
    !actor.userId ||
    action.requester?.userId !== actor.userId ||
    action.source ||
    action.policy ||
    action.toolName !== 'issue_read' ||
    action.status !== 'pending' ||
    !approval?.eligible ||
    approval.ruleId ||
    approval.usage ||
    !input
  )
    return;
  const scope: ExactApprovalScope = {
    agentName: approval.agentName,
    conversationTitle: approval.conversationTitle,
    connectionName: action.appName,
    toolName: action.toolName,
    input,
  };
  return {
    scope,
    key: JSON.stringify([
      actor.userId,
      action.id,
      action.agentId,
      action.conversationId,
      action.connectionId,
      action.expiresAt,
      scope,
    ]),
  };
}

export function parseAppApprovalRules(value: unknown): AppApprovalRule[] | undefined {
  if (!object(value) || !Array.isArray(value.rules) || value.rules.length > 20) return;
  const rules: AppApprovalRule[] = [];
  const seen = new Set<string>();
  for (const rule of value.rules) {
    if (!object(rule)) return;
    const {
      id,
      agentId,
      agentName,
      conversationId,
      conversationTitle,
      connectionId,
      connectionName,
      toolName,
      createdAt,
    } = rule;
    const input = exactAppApprovalInput(rule.input);
    if (
      !uuid(id) ||
      seen.has(id) ||
      !label(agentId) ||
      !label(agentName) ||
      !label(conversationId) ||
      !label(conversationTitle) ||
      !label(connectionId) ||
      !label(connectionName) ||
      toolName !== 'issue_read' ||
      typeof createdAt !== 'string' ||
      !Number.isFinite(Date.parse(createdAt)) ||
      !input
    )
      return;
    seen.add(id);
    rules.push({
      id,
      agentId,
      agentName,
      conversationId,
      conversationTitle,
      connectionId,
      connectionName,
      toolName,
      input,
      createdAt,
    });
  }
  return rules;
}

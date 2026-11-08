import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Info, Link2, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { AppAction } from '../../../shared/app-connections';
import type { Bootstrap } from '../../../shared/types';
import { createAppConnectionScope } from '../appConnections';
import { canDecideAction } from '../../../shared/approvals';
import { approvalHelp, approvalPendingLabel } from '../approvalUi';
import './AppsDialog.css';
import { SHARED_BOT_ID } from '../../../shared/shared-bots';
import { ApiError } from '../api';
import {
  appApprovalReview,
  exactAppApprovalInput,
  interactiveAppApproval,
} from '../appApprovalRules';
import { ExactApprovalDetails } from './apps/ExactApprovalDetails';

export function parseAppAction(value: unknown): AppAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const action = value as AppAction;
  if (
    ![
      'id',
      'conversationId',
      'agentId',
      'connectionId',
      'appName',
      'toolName',
      'createdAt',
      'expiresAt',
    ].every((key) => typeof (action as unknown as Record<string, unknown>)[key] === 'string') ||
    !action.id ||
    !action.connectionId ||
    !['pending', 'running', 'done', 'rejected', 'cancelled', 'error'].includes(action.status) ||
    !action.arguments ||
    typeof action.arguments !== 'object' ||
    Array.isArray(action.arguments) ||
    (action.error !== undefined && typeof action.error !== 'string') ||
    (action.policy !== undefined &&
      (!action.policy ||
        action.source !== undefined ||
        action.policy.kind !== 'routine_read' ||
        !SHARED_BOT_ID.test(action.policy.policyId) ||
        typeof action.policy.issuerUserId !== 'string' ||
        typeof action.policy.routineId !== 'string' ||
        typeof action.policy.routineTitle !== 'string' ||
        typeof action.policy.issuedAt !== 'string')) ||
    (action.source !== undefined &&
      (!action.source ||
        action.source.kind !== 'shared_bot' ||
        typeof action.source.shareId !== 'string' ||
        !SHARED_BOT_ID.test(action.source.shareId) ||
        typeof action.source.botName !== 'string' ||
        typeof action.source.ownerName !== 'string')) ||
    (action.result !== undefined &&
      (!action.result ||
        typeof action.result !== 'object' ||
        typeof action.result.text !== 'string' ||
        typeof action.result.isError !== 'boolean'))
  )
    return;
  if (action.interactiveApproval === undefined) return action;
  return { ...action, interactiveApproval: interactiveAppApproval(action.interactiveApproval) };
}
export function appActionStatus(action: AppAction, userId?: string) {
  if (action.status === 'done' && action.result?.isError) return uiText('apps:text_d2889d09e9eb');
  return {
    pending: approvalPendingLabel(action.requester, userId),
    running: uiText('apps:text_8f38fd93b5a0'),
    done: uiText('apps:text_f28461bb49c8'),
    rejected: uiText('apps:text_f098218a3032'),
    cancelled: uiText('apps:text_a37778f17c5f'),
    error: uiText('apps:text_2f7e4fef8d9d'),
  }[action.status];
}
type Props = {
  action: AppAction;
  owner: boolean;
  workspaceId?: string;
  userId?: string;
  onChanged: () => Promise<unknown>;
  onApps: (shareId?: string) => void;
};
export function AppActionCard(props: Props) {
  return (
    <AppActionContent
      key={`${props.userId || 'local'}:${props.workspaceId || 'local'}:${props.action.id}`}
      {...props}
    />
  );
}
function AppActionContent(props: Props) {
  const current = useRef(props);
  current.current = props;
  const [scope] = useState(() =>
    createAppConnectionScope({ ...props, identity: () => current.current }),
  );
  const [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(''),
    [unknown, setUnknown] = useState(false);
  const [received, setReceived] = useState<AppAction>();
  const [reviewKey, setReviewKey] = useState<string>();
  const [alwaysUnavailable, setAlwaysUnavailable] = useState(false);
  const reviewed = useRef<string>(undefined);
  const running = useRef(false);
  const decisionSent = useRef(false);
  const action = received && props.action.status === 'pending' ? received : props.action;
  const review = !alwaysUnavailable ? appApprovalReview(action, props) : undefined;
  const interactive = interactiveAppApproval(action.interactiveApproval);
  const reviewing = review && reviewKey === review.key;
  function setReview(key?: string) {
    reviewed.current = key;
    setReviewKey(key);
  }
  useEffect(() => {
    scope.resume();
    return () => scope.suspend();
  }, [scope]);
  useEffect(() => {
    if (props.action.status !== 'pending') {
      setUnknown(false);
      setError('');
    }
  }, [props.action.status]);
  useEffect(() => {
    if (reviewKey && reviewKey !== review?.key) setReview();
  }, [reviewKey, review?.key]);
  const expired =
    !Number.isFinite(Date.parse(action.expiresAt)) || Date.parse(action.expiresAt) <= Date.now();
  async function decide(approve: boolean | 'always_allow') {
    const ticket = scope.ticket();
    const live = current.current;
    const always = approve === 'always_allow';
    if (
      !scope.current(ticket) ||
      running.current ||
      decisionSent.current ||
      !canDecideAction(current.current.action.requester, {
        userId: current.current.userId,
        isOwner: current.current.owner,
      }) ||
      current.current.action.id !== action.id ||
      current.current.action.status !== 'pending' ||
      received ||
      unknown ||
      (always &&
        (!reviewKey ||
          reviewed.current !== reviewKey ||
          appApprovalReview(live.action, live)?.key !== reviewKey)) ||
      (approve &&
        (!Number.isFinite(Date.parse(action.expiresAt)) ||
          Date.parse(action.expiresAt) <= Date.now()))
    )
      return;
    running.current = true;
    decisionSent.current = true;
    setReview();
    setBusy(true);
    setError('');
    try {
      const result = await scope.request<AppAction>(
        `/app-actions/${encodeURIComponent(action.id)}/decision`,
        'POST',
        always ? { decision: 'always_allow' } : { approve },
      );
      if (!scope.current(ticket)) return;
      if (
        always &&
        (!parseAppAction(result) ||
          result.id !== action.id ||
          result.conversationId !== action.conversationId ||
          result.agentId !== action.agentId ||
          result.connectionId !== action.connectionId ||
          result.toolName !== action.toolName ||
          JSON.stringify(exactAppApprovalInput(result.arguments)) !==
            JSON.stringify(review?.scope.input) ||
          result.status === 'pending' ||
          !interactiveAppApproval(result.interactiveApproval)?.usage)
      )
        throw new Error(uiText('apps:approvalRuleReceiptUnknown'));
      setReceived(result);
      await current.current.onChanged();
    } catch (cause) {
      if (!scope.current(ticket)) return;
      if (
        always &&
        cause instanceof ApiError &&
        cause.status === 409 &&
        (cause.code === 'APP_APPROVAL_RULE_CHANGED' || cause.code === 'APP_APPROVAL_RULE_LIMIT')
      ) {
        decisionSent.current = false;
        setAlwaysUnavailable(true);
        setError(
          uiText(
            cause.code === 'APP_APPROVAL_RULE_LIMIT'
              ? 'apps:approvalRuleLimit'
              : 'apps:approvalRuleChanged',
          ),
        );
        return;
      }
      setError(cause instanceof Error ? cause.message : uiText('apps:text_aadb0aa37a25'));
      setUnknown(true);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setBusy(false);
    }
  }
  async function refresh() {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || running.current || refreshing) return;
    setRefreshing(true);
    try {
      const snapshot = await scope.request<Bootstrap>('/bootstrap');
      const found = snapshot.messages
        .map((message) => parseAppAction(message.metadata?.appAction))
        .find((item) => item?.id === action.id && item.conversationId === action.conversationId);
      if (!found) throw new Error(uiText('apps:text_17542b74b414'));
      if (!scope.current(ticket)) return;
      if (
        found.status === 'pending' &&
        appApprovalReview(found, current.current)?.key !==
          appApprovalReview(current.current.action, current.current)?.key
      ) {
        setAlwaysUnavailable(true);
        setReview();
      }
      setReceived(found.status === 'pending' ? undefined : found);
      decisionSent.current = found.status !== 'pending';
      setUnknown(false);
      setError('');
      await current.current.onChanged();
    } catch (cause) {
      if (scope.current(ticket))
        setError(cause instanceof Error ? cause.message : uiText('apps:text_a752223e2488'));
    } finally {
      if (scope.current(ticket)) setRefreshing(false);
    }
  }
  return (
    <div
      className={`app-action-card ${action.status === 'error' || action.result?.isError ? 'app-action-error' : ''}`}
    >
      <header>
        <span className="app-action-icon">
          <Link2 size={16} />
        </span>
        <strong>{action.appName}</strong>
        <span className="app-action-state">
          {action.status === 'running' ? (
            <Loader2 size={12} className="spin" />
          ) : action.status === 'done' && !action.result?.isError ? (
            <Check size={12} />
          ) : null}
          {appActionStatus(action, props.userId)}
        </span>
      </header>
      <p className="app-action-tool">{action.toolName}</p>
      {interactive?.usage && (
        <p className="app-approval-audit">
          <ShieldCheck size={14} aria-hidden="true" />
          {uiText(
            interactive.usage === 'saved' ? 'apps:approvalRuleSaved' : 'apps:approvalRuleReused',
          )}
        </p>
      )}
      {action.policy && (
        <p className="field-help">
          {uiText('workspace:appPolicies.audit', {
            owner:
              action.policy.issuerUserId === props.userId
                ? uiText('workspace:appPolicies.you')
                : uiText('workspace:appPolicies.owner'),
            routine: action.policy.routineTitle,
          })}
        </p>
      )}
      {action.source && (
        <p className="field-help">
          {uiText('apps:sharedAuthorization', {
            owner: action.source.ownerName,
            bot: action.source.botName,
          })}
        </p>
      )}
      <details open={action.status === 'pending'}>
        <summary>{uiText('apps:text_9400144a632a')}</summary>
        <pre>{JSON.stringify(action.arguments, null, 2)}</pre>
      </details>
      {action.status === 'pending' && (
        <p className="field-help">
          {uiText(
            action.source
              ? 'apps:publisherApproval'
              : review
                ? 'apps:approvalRuleRequestHelp'
                : 'apps:workspaceApproval',
          )}
        </p>
      )}
      {action.result && (
        <details open>
          <summary>
            {action.result.isError
              ? uiText('apps:text_21adf8605f0f')
              : uiText('apps:text_e04bd1b72f4b')}
          </summary>
          <pre>{action.result.text || uiText('apps:text_3f9c614fa3c1')}</pre>
        </details>
      )}
      {action.error && <p className="error-text">{serviceText(action.error)}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {unknown && (
        <p className="field-help" role="status">
          <Info size={13} />
          {uiText('apps:text_4322bacb6ca6')}
        </p>
      )}
      {action.status === 'pending' && expired && (
        <p className="field-help">{uiText('apps:text_3c4533676e2e')}</p>
      )}
      {action.status === 'pending' && (
        <p className="field-help">{approvalHelp(action.requester, props.userId)}</p>
      )}
      {reviewing && (
        <section className="app-approval-review" aria-label={uiText('apps:approvalRuleReview')}>
          <strong>{uiText('apps:approvalRuleReview')}</strong>
          <p className="field-help">{uiText('apps:approvalRuleScope')}</p>
          <ExactApprovalDetails scope={review.scope} />
          <div className="app-action-buttons">
            <button type="button" className="secondary-button" onClick={() => setReview()}>
              {uiText('apps:approvalRuleCancel')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy || unknown || refreshing || expired}
              onClick={() => void decide('always_allow')}
            >
              {uiText('apps:approvalRuleSave')}
            </button>
          </div>
        </section>
      )}
      <div className="app-action-buttons">
        {(unknown || (action.status === 'pending' && expired)) && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            {uiText('apps:text_802a407c7743')}
          </button>
        )}
        {action.status === 'pending' &&
          canDecideAction(action.requester, { userId: props.userId, isOwner: props.owner }) && (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || unknown || refreshing}
                onClick={() => void decide(false)}
              >
                <X size={14} />
                {uiText('apps:text_136de7a8c46f')}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || unknown || refreshing || expired}
                onClick={() => void decide(true)}
              >
                {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                {uiText('apps:text_6b49340edd35')}
              </button>
              {review && !reviewing && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || unknown || refreshing || expired}
                  onClick={() => {
                    if (
                      scope.current(scope.ticket()) &&
                      !running.current &&
                      !decisionSent.current &&
                      appApprovalReview(current.current.action, current.current)?.key === review.key
                    )
                      setReview(review.key);
                  }}
                >
                  <ShieldCheck size={14} aria-hidden="true" />
                  {uiText('apps:approvalRuleAlways')}
                </button>
              )}
            </>
          )}
      </div>
      <button
        type="button"
        className="app-action-open"
        onClick={() => {
          if (scope.current(scope.ticket()) && current.current.action.id === action.id)
            current.current.onApps(action.source?.shareId);
        }}
      >
        {action.source ? uiText('apps:text_e1c4c87ede3b') : uiText('apps:text_d014041c331a')}
        <ChevronRight size={13} />
      </button>
    </div>
  );
}

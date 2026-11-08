import { Activity, ChevronRight, Workflow, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BotAgent, Message } from '../../../shared/types';
import { uiText } from '../i18n';
import { serviceText } from '../i18n/serviceText';
import './MessageActivity.css';

type ActivityTone = 'working' | 'success' | 'error' | 'neutral';

function ActivityDisclosureView({
  label,
  state,
  tone = 'neutral',
  icon: Icon,
  children,
}: {
  label: string;
  state?: string;
  tone?: ActivityTone;
  icon: LucideIcon;
  children?: ReactNode;
}) {
  const line = (
    <>
      <Icon className="message-activity-icon" size={14} aria-hidden="true" />
      <span className="message-activity-label">{label}</span>
      {state && <span className="message-activity-state">{state}</span>}
    </>
  );
  if (!children)
    return (
      <div className="message-activity message-activity-line" data-tone={tone}>
        {line}
      </div>
    );
  return (
    <details className="message-activity" data-tone={tone}>
      <summary className="message-activity-line">
        {line}
        <ChevronRight className="message-activity-chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="message-activity-details">{children}</div>
    </details>
  );
}

function delegationMarker(message: Message) {
  const marker = message.metadata?.delegation;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return;
  const { sourceAgentId, targetAgentId } = marker as Record<string, unknown>;
  if (
    typeof sourceAgentId === 'string' &&
    typeof targetAgentId === 'string' &&
    targetAgentId === message.agentId
  )
    return { sourceAgentId, targetAgentId };
}

function activityStatus(message: Message): { state?: string; tone?: ActivityTone } {
  switch (message.delivery?.state) {
    case 'cancelled':
      return { state: uiText('workspace:activityCanceled'), tone: 'error' };
    case 'interrupted':
      return { state: uiText('workspace:activityInterrupted'), tone: 'error' };
  }
  if (message.status === 'error')
    return {
      state: uiText(
        message.metadata?.delegationProjection === true
          ? 'workspace:activityUnconfirmed'
          : 'workspace:activityFailed',
      ),
      tone: 'error',
    };
  if (message.status === 'done')
    return { state: uiText('workspace:activityComplete'), tone: 'success' };
  if (message.status === 'running')
    return { state: uiText('workspace:activityWorking'), tone: 'working' };
  if (message.delivery?.state === 'queued')
    return { state: uiText('workspace:activityQueued'), tone: 'working' };
  if (message.delivery?.state === 'delivered')
    return { state: uiText('workspace:activityReceived') };
  return {};
}

export function MessageActivity({
  message,
  agents,
  targetName,
}: {
  message: Message;
  agents: readonly Pick<BotAgent, 'id' | 'name'>[];
  targetName?: string;
}) {
  const marker = delegationMarker(message);
  const source = marker && agents.find((agent) => agent.id === marker.sourceAgentId)?.name;
  const target =
    marker && (agents.find((agent) => agent.id === marker.targetAgentId)?.name || targetName);
  const checkIn =
    !!message.metadata?.primaryCheckIn && typeof message.metadata.primaryCheckIn === 'object';
  const label = marker
    ? source && target
      ? uiText('workspace:activityHandoffBetween', { source, target })
      : target
        ? uiText('workspace:activityHandoffTo', { target })
        : uiText('workspace:activityHandoff')
    : checkIn
      ? uiText('workspace:activityCheckIn')
      : uiText('workspace:activityEvent');
  const reason = serviceText(message.delivery?.reason);
  return (
    <ActivityDisclosureView
      label={label}
      icon={marker ? Workflow : Activity}
      {...activityStatus(message)}
    >
      {message.content.trim() || reason ? (
        <>
          {message.content.trim() && <p className="message-activity-text">{message.content}</p>}
          {reason && reason !== message.content && (
            <p className="message-activity-reason">{reason}</p>
          )}
        </>
      ) : null}
    </ActivityDisclosureView>
  );
}

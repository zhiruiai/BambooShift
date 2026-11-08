import type { BotAgent } from '../../../shared/types';
import { uiText } from '../i18n';
import { useNotificationSettings } from '../useNotifications';
import type { NotificationIdentity } from '../notificationTransport';
import './NotificationsPanel.css';

type Props = NotificationIdentity & { active?: boolean; agents: BotAgent[] };
export function NotificationsPanel(props: Props) {
  return <NotificationsContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function NotificationsContent(props: Props) {
  const settings = useNotificationSettings(props);
  if (!props.userId || !props.workspaceId)
    return <p className="field-help">{uiText('workspace:notificationsAccountRequired')}</p>;
  const disabled = props.active === false || settings.requesting;
  const toggleBot = (agentId: string, enabled: boolean) => {
    if (!props.agents.some((agent) => agent.id === agentId)) return;
    const mutedBots = settings.store.getSnapshot().mutedBots;
    settings.update({
      mutedBots: enabled
        ? mutedBots.filter((id) => id !== agentId)
        : [...new Set([...mutedBots, agentId])],
    });
  };
  return (
    <section className="notifications-panel" aria-label={uiText('workspace:notificationsTitle')}>
      <p className="field-help">{uiText('workspace:notificationsDescription')}</p>
      <label className="notification-option">
        <span>
          <strong>{uiText('workspace:notificationsEnable')}</strong>
          <small>{uiText('workspace:notificationsDeviceScope')}</small>
        </span>
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(event) => settings.update({ enabled: event.target.checked })}
        />
      </label>
      <div className="notification-permission" role="status">
        <p>
          {uiText(
            (
              {
                default: 'workspace:notificationsPermissionPrompt',
                granted: 'workspace:notificationsPermissionGranted',
                denied: 'workspace:notificationsPermissionDenied',
                unsupported: 'workspace:notificationsUnsupported',
              } as const
            )[settings.permission],
          )}
        </p>
        {settings.permission !== 'granted' && settings.permission !== 'unsupported' && (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || !settings.enabled || !settings.storageAvailable}
            onClick={() => void settings.requestPermission()}
          >
            {settings.requesting
              ? uiText('workspace:notificationsRequesting')
              : uiText('workspace:notificationsAllow')}
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={settings.refresh}
        >
          {uiText('workspace:notificationsCheck')}
        </button>
      </div>
      {!settings.storageAvailable && (
        <p className="notifications-error" role="alert">
          {uiText('workspace:notificationsStorageBlocked')}
        </p>
      )}
      {settings.failed && (
        <p className="notifications-error" role="alert">
          {uiText('workspace:notificationsFailed')}
        </p>
      )}
      <fieldset disabled={disabled || !settings.enabled}>
        <legend>{uiText('workspace:notificationsEvents')}</legend>
        <label className="notification-option">
          <span>{uiText('workspace:notificationsCompleted')}</span>
          <input
            type="checkbox"
            checked={settings.completed}
            onChange={(event) => settings.update({ completed: event.target.checked })}
          />
        </label>
        <label className="notification-option">
          <span>{uiText('workspace:notificationsApprovals')}</span>
          <input
            type="checkbox"
            checked={settings.approvals}
            onChange={(event) => settings.update({ approvals: event.target.checked })}
          />
        </label>
      </fieldset>
      <fieldset disabled={disabled || !settings.enabled}>
        <legend>{uiText('workspace:notificationsBots')}</legend>
        {!props.agents.length && (
          <p className="field-help">{uiText('workspace:notificationsNoBots')}</p>
        )}
        {props.agents.map((agent) => (
          <label className="notification-option" key={agent.id}>
            <span>{agent.name}</span>
            <input
              type="checkbox"
              checked={!settings.mutedBots.includes(agent.id)}
              onChange={(event) => toggleBot(agent.id, event.target.checked)}
            />
          </label>
        ))}
      </fieldset>
      <p className="field-help">{uiText('workspace:notificationsPrivacy')}</p>
    </section>
  );
}

import {
  Bell,
  Bot,
  Brain,
  ChartNoAxesColumn,
  Monitor,
  RefreshCw,
  Settings,
  Sparkles,
} from 'lucide-react';
import { uiText } from '../../i18n';

export type SettingsSection =
  'general' | 'work' | 'memory' | 'devices' | 'models' | 'usage' | 'notifications' | 'updates';

export function settingsSectionLabel(value: SettingsSection) {
  return uiText(
    (
      {
        general: 'workspace:settingsGeneral',
        usage: 'workspace:usageTitle',
        notifications: 'workspace:notificationsTitle',
        updates: 'workspace:updatesTitle',
        work: 'workspace:settingsBotWork',
        memory: 'workspace:settingsMemory',
        devices: 'workspace:settingsDevices',
        models: 'workspace:settingsModels',
      } as const
    )[value],
  );
}

export function SettingsNavigation({
  value,
  canManage,
  blocked,
  recoverable = [],
  onChange,
}: {
  value: SettingsSection;
  canManage: boolean;
  blocked: boolean;
  recoverable?: SettingsSection[];
  onChange: (value: SettingsSection) => void;
}) {
  const items = [
    { id: 'general', label: uiText('workspace:settingsGeneral'), icon: Settings },
    { id: 'work', label: uiText('workspace:settingsBotWork'), icon: Bot },
    { id: 'memory', label: uiText('workspace:settingsMemory'), icon: Brain },
    { id: 'usage', label: uiText('workspace:usageTitle'), icon: ChartNoAxesColumn },
    { id: 'notifications', label: uiText('workspace:notificationsTitle'), icon: Bell },
    { id: 'devices', label: uiText('workspace:settingsDevices'), icon: Monitor },
    { id: 'updates', label: uiText('workspace:updatesTitle'), icon: RefreshCw },
    ...(canManage
      ? [{ id: 'models', label: uiText('workspace:settingsModels'), icon: Sparkles }]
      : []),
  ] as const;
  return (
    <nav
      className="workspace-settings-navigation"
      aria-label={uiText('workspace:settingsCategories')}
    >
      {items.map(({ id, label, icon: Icon }) => (
        <button
          type="button"
          key={id}
          aria-current={value === id ? 'page' : undefined}
          disabled={blocked && value !== id && !recoverable.includes(id as SettingsSection)}
          onClick={() => onChange(id as SettingsSection)}
          onKeyDown={(event) => {
            if (
              !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            const buttons = [
              ...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)',
              ) || []),
            ];
            const current = buttons.indexOf(event.currentTarget);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (current +
                      (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          <Icon size={18} aria-hidden="true" />
          <span>{label}</span>
          {recoverable.includes(id as SettingsSection) && (
            <small>{uiText('workspace:settingsNeedsReview')}</small>
          )}
        </button>
      ))}
    </nav>
  );
}

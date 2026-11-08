import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bot, ChevronRight } from 'lucide-react';
import {
  SettingsNavigation,
  settingsSectionLabel,
  type SettingsSection,
} from './workspaceSettings/SettingsNavigation';
import { SettingsAccountCard } from './workspaceSettings/SettingsAccountCard';
import type { AppSettings, Bootstrap } from '../../../shared/types';
import type { PrimaryBotState } from '../../../shared/primary-bot';
import type { MemoryImportReceipt } from '../../../shared/memory-imports';
import type { WorkspaceTimeZoneState } from '../../../shared/workspace-time-zone';
import { createPrimaryBotScope, type confirmedPrimary } from '../primaryBot';
import { DeviceSettings } from './DeviceSettings';
import { PrimaryBotDialog } from './PrimaryBotDialog';
import { SettingsDialog } from './SettingsDialog';
import { UsagePanel } from './UsagePanel';
import { UpdatesPanel } from './UpdatesPanel';
import { NotificationsPanel } from './NotificationsPanel';
import { MemoryImportPanel } from './MemoryImportPanel';
import { AppearanceSettings } from './AppearanceSettings';
import { WorkspaceTimeZoneSettings } from './WorkspaceTimeZoneSettings';
import { Dialog } from './UI';
import './WorkspaceSettingsDialog.css';

type Props = {
  data: Bootstrap;
  workspaceId?: string;
  userId?: string;
  canManage: boolean;
  team: boolean;
  initialView?: 'general' | 'models';
  personalHref?: string;
  onClose: () => void;
  onSettingsChanged: (settings: AppSettings) => void;
  onPrimaryChanged: (
    state: PrimaryBotState,
    confirmed?: ReturnType<typeof confirmedPrimary>,
  ) => void;
  onImported: (receipt: MemoryImportReceipt) => Promise<void>;
  onTimeZoneChanged: (state: WorkspaceTimeZoneState) => void;
};
export function WorkspaceSettingsDialog(props: Props) {
  return <WorkspaceSettingsContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function WorkspaceSettingsContent(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createPrimaryBotScope({ ...props, identity: () => latest.current }),
  );
  const [view, setView] = useState<SettingsSection | 'primary'>(() =>
    props.canManage ? props.initialView || 'general' : 'general',
  );
  const currentView =
    !props.canManage && (view === 'models' || view === 'primary') ? 'general' : view;
  const returnView = useRef<Exclude<SettingsSection, 'models'>>('general');
  const shellActive = currentView !== 'models' && currentView !== 'primary';
  const activity = useRef({ dirty: false, busy: false, pending: false });
  const activities = useRef({
    memory: { dirty: false, busy: false, pending: false },
    timeZone: { dirty: false, busy: false, pending: false },
  });
  const [blocked, setBlocked] = useState(false);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  useEffect(() => {
    scope.resume();
    return () => scope.suspend();
  }, [scope]);
  const current = () => scope.current(scope.ticket());
  function setActivity(source: 'memory' | 'timeZone', value: typeof activity.current) {
    activities.current[source] = value;
    const values = Object.values(activities.current);
    activity.current = {
      dirty: values.some((item) => item.dirty),
      busy: values.some((item) => item.busy),
      pending: values.some((item) => item.pending),
    };
    setBlocked(activity.current.busy || activity.current.pending);
  }
  function configure(next: 'models' | 'primary') {
    if (
      !current() ||
      activity.current.busy ||
      activity.current.pending ||
      !latest.current.canManage
    )
      return;
    if (next === 'primary' && latest.current.team) return;
    setLeave(null);
    if (currentView !== 'models' && currentView !== 'primary') returnView.current = currentView;
    setView(next);
  }
  function selectSection(next: SettingsSection) {
    if (!current() || activity.current.busy) return;
    if (
      activity.current.pending &&
      !(
        (next === 'memory' && activities.current.memory.pending) ||
        (next === 'work' && activities.current.timeZone.pending)
      )
    )
      return;
    if (next === 'models') configure('models');
    else {
      setLeave(null);
      setView(next);
    }
  }
  function navigate(work: () => void) {
    if (!current() || activity.current.busy) return;
    if (activity.current.dirty || activity.current.pending) setLeave(() => work);
    else work();
  }
  const close = () => navigate(() => latest.current.onClose());
  return (
    <>
      <Dialog
        scrollBody={false}
        title={uiText('settings:text_df3d58c7d84b')}
        wide
        active={shellActive}
        onClose={close}
        className="workspace-settings"
      >
        <div className="workspace-settings-layout">
          <SettingsNavigation
            value={shellActive ? currentView : returnView.current}
            canManage={props.canManage}
            blocked={blocked}
            recoverable={[
              ...(activities.current.memory.pending ? ['memory' as const] : []),
              ...(activities.current.timeZone.pending ? ['work' as const] : []),
            ]}
            onChange={selectSection}
          />
          <div
            className="workspace-settings-main"
            role="region"
            aria-labelledby={`settings-section-${shellActive ? currentView : returnView.current}`}
            tabIndex={0}
          >
            {leave && (
              <div className="bot-form-notice" role="alert">
                <p>
                  {activities.current.memory.pending
                    ? uiText('settings:text_e3289dec02cd')
                    : activities.current.timeZone.pending
                      ? uiText('settings:text_2045de129cee')
                      : activities.current.memory.dirty
                        ? uiText('settings:text_c7f5ffb5b54f')
                        : uiText('settings:text_15347acbcc34')}
                </p>
                <div>
                  <button type="button" className="secondary-button" onClick={() => setLeave(null)}>
                    {uiText('settings:text_fd4b9e3b6c68')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      if (!current() || activity.current.busy) return;
                      const work = leave;
                      setLeave(null);
                      work();
                    }}
                  >
                    {uiText('settings:text_9b5166563f34')}
                  </button>
                </div>
              </div>
            )}
            <section
              className="workspace-settings-panel"
              hidden={currentView !== 'general'}
              inert={currentView !== 'general'}
              aria-labelledby="settings-section-general"
            >
              <h2 id="settings-section-general">{uiText('workspace:settingsGeneral')}</h2>
              <SettingsAccountCard
                userId={props.userId}
                onAccount={() => navigate(() => window.location.assign('/account'))}
              />
              <AppearanceSettings
                active={currentView === 'general'}
                generation={
                  props.canManage && props.workspaceId && props.userId
                    ? {
                        workspaceId: props.workspaceId,
                        userId: props.userId,
                        configured: !!props.data.settings.configured,
                      }
                    : undefined
                }
              />
            </section>
            <section
              className="workspace-settings-panel"
              hidden={currentView !== 'work'}
              inert={currentView !== 'work'}
              aria-labelledby="settings-section-work"
            >
              <h2 id="settings-section-work">{uiText('workspace:settingsBotWork')}</h2>
              <div className="workspace-settings-section workspace-settings-card">
                {props.team ? (
                  <>
                    <p className="field-help">{uiText('settings:text_2ed7a8ed1a3f')}</p>
                    {props.personalHref && (
                      <a
                        className="secondary-button"
                        href={props.personalHref}
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(() => window.location.assign(props.personalHref!));
                        }}
                      >
                        {uiText('settings:text_a88158b8268a')}
                        <ArrowUpRight size={14} />
                      </a>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    className="workspace-settings-row"
                    disabled={blocked || !props.canManage}
                    onClick={() => configure('primary')}
                  >
                    <Bot size={17} />
                    <span>
                      {uiText('settings:text_33bc0375810d')}
                      <small>
                        {props.data.agents.find(
                          (agent) => agent.id === props.data.primaryBot?.agentId,
                        )?.name || uiText('settings:text_c5768ca9726c')}
                      </small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                )}
              </div>
              <WorkspaceTimeZoneSettings
                workspaceId={props.workspaceId}
                userId={props.userId}
                canManage={props.canManage}
                active={currentView === 'work'}
                initialState={props.data.workspaceTimeZone}
                onActivity={(value) => setActivity('timeZone', value)}
                onSaved={(state) => {
                  if (current()) latest.current.onTimeZoneChanged(state);
                }}
              />
            </section>
            <section
              className="workspace-settings-panel"
              hidden={currentView !== 'memory'}
              inert={currentView !== 'memory'}
              aria-labelledby="settings-section-memory"
            >
              <h2 id="settings-section-memory">{uiText('workspace:settingsMemory')}</h2>
              <MemoryImportPanel
                workspaceId={props.workspaceId}
                userId={props.userId}
                active={currentView === 'memory'}
                personalHref={props.personalHref}
                onConfigurePrimary={() => configure('primary')}
                onConfigureModel={() => configure('models')}
                onActivity={(value) => setActivity('memory', value)}
                onImported={async (receipt) => {
                  if (!current()) throw Error(uiText('settings:text_ade6249372fb'));
                  const timeZone = activities.current.timeZone;
                  if (timeZone.dirty || timeZone.busy || timeZone.pending)
                    throw Error(uiText('settings:text_913d3cc79296'));
                  await latest.current.onImported(receipt);
                }}
              />
            </section>
            <section
              className="workspace-settings-panel"
              hidden={currentView !== 'devices'}
              inert={currentView !== 'devices'}
              aria-labelledby="settings-section-devices"
            >
              <h2 id="settings-section-devices">{uiText('workspace:settingsDevices')}</h2>
              <DeviceSettings />
            </section>
            <section
              className="workspace-settings-panel"
              hidden={currentView !== 'notifications'}
              inert={currentView !== 'notifications'}
              aria-labelledby="settings-section-notifications"
            >
              <h2 id="settings-section-notifications">{uiText('workspace:notificationsTitle')}</h2>
              <NotificationsPanel
                workspaceId={props.workspaceId}
                userId={props.userId}
                agents={props.data.agents}
                active={currentView === 'notifications'}
              />
            </section>
            <section
              className="workspace-settings-panel"
              hidden={currentView !== 'usage'}
              inert={currentView !== 'usage'}
              aria-labelledby="settings-section-usage"
            >
              <h2 id="settings-section-usage">{uiText('workspace:usageTitle')}</h2>
              <UsagePanel
                workspaceId={props.workspaceId}
                userId={props.userId}
                active={currentView === 'usage'}
              />
            </section>
            <section
              className="workspace-settings-panel"
              hidden={currentView !== 'updates'}
              inert={currentView !== 'updates'}
              aria-labelledby="settings-section-updates"
            >
              <h2 id="settings-section-updates">{uiText('workspace:updatesTitle')}</h2>
              <UpdatesPanel
                workspaceId={props.workspaceId}
                userId={props.userId}
                active={currentView === 'updates'}
              />
            </section>
            {!props.canManage && (
              <p className="model-settings-note">{uiText('settings:text_d718135ff3b9')}</p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={activity.current.busy}
                onClick={close}
              >
                {uiText('settings:text_c0b3fbff51cc')}
              </button>
            </div>
          </div>
        </div>
      </Dialog>
      {props.canManage && (
        <SettingsDialog
          active={currentView === 'models'}
          settings={props.data.settings}
          workspaceId={props.workspaceId}
          userId={props.userId}
          closeLabel={
            returnView.current === 'general'
              ? uiText('settings:text_3b88849bff9d')
              : uiText('workspace:settingsReturnToCategory', {
                  category: settingsSectionLabel(returnView.current),
                })
          }
          onClose={() => {
            if (current()) setView(returnView.current);
          }}
          onSettingsChanged={(settings) => {
            if (current()) latest.current.onSettingsChanged(settings);
          }}
        />
      )}
      {currentView === 'primary' && (
        <PrimaryBotDialog
          state={props.data.primaryBot}
          defaultTimeZone={props.data.workspaceTimeZone?.timeZone}
          checkInStatus={props.data.primaryCheckIn}
          agents={props.data.agents}
          workspaceId={props.workspaceId}
          userId={props.userId}
          team={props.team}
          personalHref={props.personalHref}
          onClose={() => {
            if (current()) setView(returnView.current);
          }}
          onSaved={(state, confirmed) => {
            if (!current()) return;
            latest.current.onPrimaryChanged(state, confirmed);
            setView(returnView.current);
          }}
        />
      )}
    </>
  );
}

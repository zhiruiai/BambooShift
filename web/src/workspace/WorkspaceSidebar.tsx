import { useEffect, useRef, useState } from 'react';
import { NewChatPicker } from '../components/NewChatPicker';
import { uiText } from '../i18n';
import { ChevronRight, FolderOpen, Plus, Search, Settings, Terminal, Zap } from 'lucide-react';
import { MobileBotShortcuts, MobileHomeHeader } from '../components/MobileHome';
import { SidebarRosterList } from '../components/SidebarRoster';
import { IconButton } from '../components/UI';
import { AccountMenu } from '../platform/AccountAccess';
import type { WorkspaceModel } from './types';

export function WorkspaceSidebar({
  mobileHome,
  account,
  openSettings,
  openApps,
  online,
  connectionLabel,
  refresh,
  canManage,
  openSearch,
  openCreate,
  search,
  setSearch,
  data,
  sidebar,
  selected,
  primary,
  conversationWorking,
  sendScope,
  openConversation,
  clockNow,
  roster,
  openRoster,
  openPrimary,
  setToast,
  sync,
  navigationScope,
  modal,
}: Pick<
  WorkspaceModel,
  | 'mobileHome'
  | 'account'
  | 'openSettings'
  | 'openApps'
  | 'online'
  | 'connectionLabel'
  | 'refresh'
  | 'canManage'
  | 'openSearch'
  | 'openCreate'
  | 'search'
  | 'setSearch'
  | 'data'
  | 'sidebar'
  | 'selected'
  | 'primary'
  | 'conversationWorking'
  | 'sendScope'
  | 'openConversation'
  | 'clockNow'
  | 'roster'
  | 'openRoster'
  | 'openPrimary'
  | 'setToast'
  | 'sync'
  | 'navigationScope'
  | 'modal'
>) {
  const [picker, setPicker] = useState<{ scope: string; ticket: number }>();
  const latest = useRef({ navigationScope, modal, sendScope });
  latest.current = { navigationScope, modal, sendScope };
  useEffect(() => setPicker(undefined), [navigationScope, modal]);
  function openPicker() {
    const ticket = sendScope.ticket();
    if (!modal && sendScope.current(ticket)) setPicker({ scope: navigationScope, ticket });
  }
  const pickerCurrent = () =>
    !!picker &&
    latest.current.navigationScope === picker.scope &&
    !latest.current.modal &&
    latest.current.sendScope.current(picker.ticket);
  return (
    <>
      <aside className="sidebar" aria-label={uiText('workspace:text_c980de330fcb')}>
        {mobileHome && (
          <MobileHomeHeader
            accountMenu={
              account ? (
                <AccountMenu
                  session={account.session}
                  activeWorkspaceId={account.workspace.id}
                  onSettings={() => openSettings()}
                  onApps={() => openApps()}
                />
              ) : undefined
            }
            online={online}
            connectionLabel={online ? undefined : connectionLabel}
            onRetry={refresh}
            canCreateBot={canManage}
            onSettings={() => openSettings()}
            onApps={() => openApps()}
            onSearch={() => openSearch('all')}
            onCreate={openPicker}
            createLabel={uiText('workspace:newChatTitle')}
          />
        )}
        <div className="sidebar-toolbar">
          <div className="window-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <span className="app-wordmark">BambooShift</span>
          <div className="toolbar-actions">
            <IconButton
              label={uiText('workspace:text_feb95554de09')}
              onClick={() => openSearch('all')}
            >
              <Search size={17} />
            </IconButton>
            <IconButton label={uiText('workspace:newChatTitle')} onClick={openPicker}>
              <Plus size={20} />
            </IconButton>
          </div>
        </div>
        <label className="search-box">
          <Search size={14} />
          <input
            id="conversation-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={uiText('workspace:text_0db24603a35b')}
          />
          <kbd>⌘ K</kbd>
        </label>
        <div className="conversation-list">
          {mobileHome && (
            <MobileBotShortcuts
              agents={data.agents}
              conversations={sidebar.visible}
              sidebarRoster={data.sidebarRoster}
              selectedId={selected}
              primaryConversationId={primary?.id}
              isWorking={conversationWorking}
              onOpen={(target) => {
                if (sendScope.current(sendScope.ticket())) openConversation(target);
              }}
            />
          )}
          <SidebarRosterList
            data={data}
            query={search}
            mobile={mobileHome}
            selected={selected}
            now={clockNow}
            roster={roster}
            onOpen={(target) => {
              if (sendScope.current(sendScope.ticket())) openConversation(target);
            }}
            working={conversationWorking}
            onDialog={openRoster}
            onPrimary={openPrimary}
            onNotice={setToast}
          />
        </div>
        <div className="sidebar-bottom">
          <button className="connect-apps" onClick={() => openApps()}>
            <span className="apps-icon">
              <Zap size={14} />
            </span>
            <span>{uiText('workspace:text_b1bea2878095')}</span>
            <span className="app-symbols">
              <span className="symbol-files">
                <FolderOpen size={13} />
              </span>
              <span className="symbol-terminal">
                <Terminal size={12} />
              </span>
            </span>
            <ChevronRight size={13} />
          </button>
          <div className="profile-row">
            {account ? (
              <AccountMenu session={account.session} activeWorkspaceId={account.workspace.id} />
            ) : (
              <button className="profile-button" onClick={() => openSettings()}>
                <span className="user-avatar">H</span>
                <span>
                  {uiText('workspace:text_e30e9ba009e8')}
                  <small>
                    <span className={`tiny-dot ${online ? '' : 'disconnected'}`} />
                    {online
                      ? uiText('workspace:text_8d3e69d58cfc')
                      : sync.phase === 'syncing'
                        ? uiText('workspace:text_73049ea75578')
                        : uiText('workspace:text_360f969c99aa')}
                  </small>
                </span>
              </button>
            )}
            <IconButton
              label={uiText('workspace:text_df3d58c7d84b')}
              onClick={() => openSettings()}
            >
              <Settings size={17} />
            </IconButton>
          </div>
        </div>
      </aside>
      {pickerCurrent() && (
        <NewChatPicker
          key={navigationScope}
          data={data}
          canCreateBot={canManage}
          isCurrent={pickerCurrent}
          onClose={() => setPicker(undefined)}
          onOpen={openConversation}
          onCreate={(mode) => openCreate(undefined, mode)}
        />
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { ConversationExportDialog } from '../components/ConversationExportDialog';
import { uiText } from '../i18n';
import {
  ArrowLeft,
  Download,
  BookOpen,
  ChevronDown,
  EyeOff,
  FolderOpen,
  Info,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
} from 'lucide-react';
import { SIDEBAR_MAX_SECTIONS, sidebarTargetForConversation } from '../../../shared/sidebar-roster';
import { conversationVisibility } from '../approvalUi';
import { Avatar, GroupAvatar } from '../components/Avatar';
import { IconButton } from '../components/UI';
import type { WorkspaceModel } from './types';
import { messageAvatarMotion } from './ChatAvatar';

export function ChatHeader({
  draggingFiles,
  uploading,
  selected,
  conversation,
  showConversationList,
  toggleDetails,
  members,
  lead,
  working,
  messages,
  canManage,
  currentUserId,
  account,
  currentRosterEntry,
  openComputer,
  showDetail,
  setMenuOpen,
  menuOpen,
  openSearch,
  setInspected,
  setModal,
  rosterLocked,
  changeRoster,
  openRoster,
  roster,
  online,
  connectionLabel,
  refresh,
  sendScope,
}: Pick<
  WorkspaceModel,
  | 'draggingFiles'
  | 'uploading'
  | 'selected'
  | 'conversation'
  | 'showConversationList'
  | 'toggleDetails'
  | 'members'
  | 'lead'
  | 'working'
  | 'messages'
  | 'canManage'
  | 'currentUserId'
  | 'account'
  | 'currentRosterEntry'
  | 'openComputer'
  | 'showDetail'
  | 'setMenuOpen'
  | 'menuOpen'
  | 'openSearch'
  | 'setInspected'
  | 'setModal'
  | 'rosterLocked'
  | 'changeRoster'
  | 'openRoster'
  | 'roster'
  | 'online'
  | 'connectionLabel'
  | 'refresh'
  | 'sendScope'
>) {
  const [exportTarget, setExportTarget] = useState<{ id: string; ticket: number }>();
  const exportId = exportTarget?.id;
  useEffect(() => setExportTarget(undefined), [conversation?.id]);
  const exportCurrent = useMemo(
    () => () => !!exportTarget && sendScope.current(exportTarget.ticket),
    [sendScope, exportTarget],
  );
  const recent = online
    ? messages.findLast((message) => message.role === 'user' || message.role === 'assistant')
    : undefined;
  const streaming =
    recent?.status === 'running' &&
    recent.metadata?.streamEnded !== true &&
    !!recent.content &&
    (!recent.kind || recent.kind === 'text');
  const activity =
    recent?.role === 'assistant'
      ? messageAvatarMotion(recent, streaming, { isOwner: canManage, userId: currentUserId })
      : undefined;
  const avatarMotion =
    activity === 'attention' || activity === 'working'
      ? activity
      : online && working
        ? 'thinking'
        : online && lead?.status === 'idle'
          ? 'idle'
          : undefined;
  const title = conversation?.title || uiText('workspace:text_56ca721193c9');
  return (
    <>
      {draggingFiles && (
        <div className="file-drop-overlay" role="status">
          <div>
            <Paperclip size={29} />
            <strong>
              {uploading.has(selected)
                ? uiText('workspace:text_4cc5c825fcbe')
                : uiText('workspace:text_b304b9865a35')}
            </strong>
            <span>
              {uploading.has(selected)
                ? uiText('workspace:text_74ab3b697dc6')
                : uiText('workspace:text_5416caf8a9b1', {
                    value0: conversation?.title || uiText('workspace:text_9800a458c16b'),
                  })}
            </span>
          </div>
        </div>
      )}
      {conversation && (
        <header className="chat-header">
          <IconButton
            label={uiText('workspace:text_acd04aa66912')}
            className="mobile-back"
            onClick={showConversationList}
          >
            <ArrowLeft size={20} />
          </IconButton>
          <button
            type="button"
            className="chat-title"
            aria-expanded={showDetail}
            title={title}
            onClick={() => toggleDetails()}
          >
            {conversation.isGroup ? (
              <GroupAvatar
                key={conversation.id}
                agents={members}
                size={34}
                motion={avatarMotion}
                sustain
              />
            ) : (
              <Avatar
                key={`${conversation.id}:${lead?.id || ''}`}
                agent={lead}
                size={34}
                motion={avatarMotion}
                sustain
              />
            )}
            <span className="chat-title-copy">
              <strong>{title}</strong>
              <small className={working && online ? 'chat-title-working' : undefined}>
                {working && online
                  ? uiText('workspace:text_e556fe53f2b0')
                  : conversation.isGroup
                    ? uiText('workspace:text_2639e5250a8e', { value0: members.length })
                    : lead?.role || uiText('workspace:text_da8763838968')}
                {' · '}
                {conversationVisibility(account?.workspace.kind)}
              </small>
            </span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          <div className="chat-header-actions">
            {currentRosterEntry?.hidden && (
              <span
                className="roster-hidden-label"
                role="img"
                aria-label={uiText('workspace:text_19bd80d599f8')}
                title={uiText('workspace:text_19bd80d599f8')}
              >
                <EyeOff size={14} aria-hidden="true" />
                <span>{uiText('workspace:text_19bd80d599f8')}</span>
              </span>
            )}
            <IconButton
              label={uiText('workspace:text_555a2f61cb96')}
              className="chat-computer-trigger"
              onClick={() => openComputer()}
            >
              <Monitor size={17} />
              <span>{uiText('computer:location_entry')}</span>
            </IconButton>
            <IconButton
              label={
                showDetail
                  ? uiText('workspace:text_2e1b7da4ea20')
                  : uiText('workspace:text_448d5d3878d0')
              }
              onClick={() => toggleDetails()}
            >
              <span className="panel-icon" />
            </IconButton>
            <div className="menu-wrap">
              <IconButton
                label={uiText('workspace:text_13f11c966a78')}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <MoreHorizontal size={18} />
              </IconButton>
              {menuOpen && (
                <div className="dropdown-menu">
                  <button
                    onClick={() => {
                      const ticket = sendScope.ticket();
                      if (!sendScope.current(ticket)) return;
                      setExportTarget({ id: conversation.id, ticket });
                      setMenuOpen(false);
                    }}
                  >
                    <Download size={15} />
                    {uiText('workspace:exportTitle')}
                  </button>
                  <button onClick={() => openSearch('current')}>
                    <Search size={15} />
                    {uiText('workspace:text_f36015210bfe')}
                  </button>
                  <button
                    onClick={() => {
                      setInspected(lead?.id || '');
                      setModal('agent');
                      setMenuOpen(false);
                    }}
                  >
                    <Info size={15} />
                    {uiText('workspace:text_304c3ba28dc5')}
                  </button>
                  <button
                    disabled={rosterLocked}
                    onClick={() =>
                      void changeRoster(
                        {
                          type: 'set-entry',
                          target: sidebarTargetForConversation(conversation),
                          pinned: !currentRosterEntry?.pinned,
                        },
                        currentRosterEntry?.pinned
                          ? uiText('workspace:text_860d0b406a8c')
                          : uiText('workspace:text_fb47db5e65ff'),
                      )
                    }
                  >
                    <MessageCircle size={15} />
                    {currentRosterEntry?.pinned
                      ? uiText('workspace:text_c92179b74af6')
                      : uiText('workspace:text_1fd17bddc21b')}
                  </button>
                  <button
                    disabled={rosterLocked}
                    onClick={() =>
                      openRoster({
                        kind: 'move',
                        target: sidebarTargetForConversation(conversation),
                      })
                    }
                  >
                    <FolderOpen size={15} />
                    {uiText('workspace:text_3c8ed10128b7')}
                  </button>
                  <button
                    disabled={
                      rosterLocked || (roster.state?.sections.length || 0) >= SIDEBAR_MAX_SECTIONS
                    }
                    onClick={() =>
                      openRoster({
                        kind: 'create',
                        target: sidebarTargetForConversation(conversation),
                      })
                    }
                  >
                    <Plus size={15} />
                    {uiText('workspace:text_3d8e5f3e634a')}
                  </button>
                  <button
                    disabled={rosterLocked}
                    onClick={() =>
                      void changeRoster(
                        {
                          type: 'set-entry',
                          target: sidebarTargetForConversation(conversation),
                          hidden: !currentRosterEntry?.hidden,
                        },
                        currentRosterEntry?.hidden
                          ? uiText('workspace:text_12f3d007b8e1')
                          : uiText('workspace:text_b7507003b29f'),
                      )
                    }
                  >
                    <EyeOff size={15} />
                    {currentRosterEntry?.hidden
                      ? uiText('workspace:text_53ddfeab5fb9')
                      : uiText('workspace:text_83904b4bc8bf')}
                  </button>
                  <button onClick={() => openRoster({ kind: 'hidden' })}>
                    <EyeOff size={15} />
                    {uiText('workspace:text_e9e644e607fb')}
                  </button>
                  <button
                    onClick={() => {
                      setModal('memory');
                      setMenuOpen(false);
                    }}
                  >
                    <BookOpen size={15} />
                    {uiText('workspace:text_a50ce9933a90')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
      )}
      {exportId && exportId === conversation?.id && account?.workspace.id && currentUserId && (
        <ConversationExportDialog
          key={`${account.workspace.id}:${exportId}`}
          conversationId={exportId}
          workspaceId={account.workspace.id}
          userId={currentUserId}
          current={exportCurrent}
          onClose={() => setExportTarget(undefined)}
        />
      )}
      {!online && (
        <div className="connection-banner" role="status">
          <span>
            {connectionLabel}
            {uiText('workspace:text_08d678af9b9f')}
          </span>
          <button type="button" onClick={() => void refresh()}>
            {uiText('workspace:text_4a7af23b6505')}
          </button>
        </div>
      )}
    </>
  );
}

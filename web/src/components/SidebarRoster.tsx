import { uiText } from '../i18n';
import { chatMessageText } from '../i18n/serviceText';
import {
  ChevronDown,
  ChevronRight,
  EyeOff,
  FolderPlus,
  Pin,
  RefreshCw,
  Search,
} from 'lucide-react';
import { isSharedBot } from '../../../shared/shared-bots';
import {
  SIDEBAR_MAX_SECTIONS,
  sidebarTargetForConversation,
  type SidebarRosterOperation,
} from '../../../shared/sidebar-roster';
import type { Bootstrap, Conversation } from '../../../shared/types';
import { conversationTime } from '../dates';
import { conversationRosterEntry, projectSidebar, sidebarTargetKey } from '../sidebarRoster';
import { Avatar, GroupAvatar } from './Avatar';
import { PrimaryBotEntry, primaryBotSummary } from './PrimaryBotEntry';
import './SidebarRoster.css';
import { RosterActions } from './roster/RosterActions';
import { ListProps, MenuAction } from './roster/types';
export { RosterManagementDialog } from './roster/RosterManagementDialog';
export type { RosterDialogRequest } from './roster/types';
export function SidebarRosterList(props: ListProps) {
  const { data, roster } = props,
    projection = projectSidebar(data, props.query, props.mobile);
  const agentsById = new Map(data.agents.map((agent) => [agent.id, agent]));
  const preferences = new Map(
    (roster.state?.entries || []).map((entry) => [sidebarTargetKey(entry.target), entry]),
  );
  const latestMessages = new Map(
    data.messages
      .filter((message) => message.kind !== 'web_research')
      .map((message) => [message.conversationId, message]),
  );
  const locked = !roster.state || roster.busy || roster.needsSync;
  async function write(operation: SidebarRosterOperation, notice: string) {
    const fallback =
      operation.type === 'set-entry' && operation.hidden
        ? document.getElementById('roster-hidden-entry')
        : null;
    const result = await roster.write(operation);
    if (result.ok) {
      if (notice) props.onNotice(notice);
      if (fallback)
        requestAnimationFrame(() => {
          if (fallback.isConnected) fallback.focus();
        });
    }
  }
  function row(conversation: Conversation) {
    const agents = conversation.agentIds
        .map((id) => agentsById.get(id))
        .filter((agent): agent is Bootstrap['agents'][number] => !!agent),
      target = sidebarTargetForConversation(conversation),
      entry = preferences.get(sidebarTargetKey(target)) || {
        ...conversationRosterEntry(conversation, undefined),
        pinned: roster.state ? false : conversation.pinned,
      },
      primary = conversation.id === projection.primary?.id;
    const last = latestMessages.get(conversation.id),
      working = props.working(conversation.id);
    const actions: MenuAction[] = [
      {
        label: entry.pinned
          ? uiText('common:text_c92179b74af6')
          : uiText('common:text_173f88d28ebf'),
        disabled: locked,
        action: () =>
          void write(
            { type: 'set-entry', target, pinned: !entry.pinned },
            entry.pinned ? uiText('common:text_860d0b406a8c') : uiText('common:text_fb47db5e65ff'),
          ),
      },
      {
        label: uiText('common:text_3c8ed10128b7'),
        disabled: locked,
        action: () => props.onDialog({ kind: 'move', target }),
      },
      {
        label: uiText('common:text_3d8e5f3e634a'),
        disabled: locked || (roster.state?.sections.length || 0) >= SIDEBAR_MAX_SECTIONS,
        action: () => props.onDialog({ kind: 'create', target }),
      },
      {
        label: uiText('common:text_145219e726b8'),
        disabled: locked,
        action: () =>
          void write(
            { type: 'set-entry', target, hidden: true },
            uiText('common:text_b7507003b29f'),
          ),
      },
    ];
    if (primary)
      actions.push({ label: uiText('common:text_7132c30c9883'), action: props.onPrimary });
    return (
      <RosterActions
        key={conversation.id}
        label={uiText('common:text_f1bf774f2355', { value0: conversation.title })}
        actions={actions}
      >
        <button
          type="button"
          className={`conversation-row roster-conversation ${props.selected === conversation.id ? 'selected' : ''}`}
          onClick={() => props.onOpen(conversation)}
        >
          <span className="conversation-avatar">
            {conversation.isGroup ? <GroupAvatar agents={agents} /> : <Avatar agent={agents[0]} />}{' '}
            {working && <span className="status-dot working" />}
          </span>
          <span className="conversation-copy">
            <span className="conversation-heading">
              <span>{conversation.title}</span>
              {!conversation.isGroup && isSharedBot(agents[0]) && (
                <small className="primary-bot-badge">{uiText('common:text_4d6a4bc105dd')}</small>
              )}
              {primary ? (
                <small className="primary-bot-badge">{uiText('common:text_33bc0375810d')}</small>
              ) : (
                <time>{conversationTime(conversation.updatedAt, props.now)}</time>
              )}
            </span>
            <span className={`conversation-preview ${working ? 'preview-working' : ''}`}>
              {primary && data.primaryBot
                ? primaryBotSummary(data.primaryBot, conversation, working, data.primaryCheckIn)
                : working
                  ? uiText('common:text_1967f541db92')
                  : (last &&
                      chatMessageText(last)
                        .replace(/[#*`\[\]]/g, '')
                        .slice(0, 75)) ||
                    agents[0]?.description ||
                    uiText('common:text_cc628b087505')}
            </span>
          </span>
          {conversation.unread > 0 && <span className="unread-badge">{conversation.unread}</span>}
        </button>
      </RosterActions>
    );
  }
  return (
    <>
      {!data.primaryBot?.agentId && (
        <PrimaryBotEntry
          state={data.primaryBot}
          selected={false}
          working={false}
          onOpen={props.onOpen}
          onManage={() => props.onPrimary()}
        />
      )}
      {projection.standalone && <div className="roster-primary">{row(projection.standalone)}</div>}
      {projection.pinned.length > 0 && (
        <section className="roster-section" aria-label={uiText('common:text_173f88d28ebf')}>
          <div className="roster-section-title">
            <Pin size={12} />
            <span>{uiText('common:text_173f88d28ebf')}</span>
            <small>{projection.pinned.length}</small>
          </div>
          {projection.pinned.map(row)}
        </section>
      )}
      {projection.sections
        .filter(
          (section) => !props.query.trim() || props.mobile || section.conversations.length > 0,
        )
        .map((section) => (
          <section className="roster-section" key={section.id} aria-label={section.name}>
            <RosterActions
              label={uiText('common:text_71bd9e16d579', { value0: section.name })}
              actions={[
                {
                  label: uiText('common:text_ad87505cb7d7'),
                  disabled: locked,
                  action: () => props.onDialog({ kind: 'rename', id: section.id }),
                },
                {
                  label: uiText('common:text_1360fe153f81'),
                  disabled: locked,
                  action: () => props.onDialog({ kind: 'delete', id: section.id }),
                },
              ]}
            >
              <button
                type="button"
                className="roster-section-title roster-section-toggle"
                disabled={locked}
                aria-expanded={section.expanded}
                onClick={() =>
                  void write(
                    {
                      type: 'set-section-collapsed',
                      id: section.id,
                      collapsed: !section.collapsed,
                    },
                    '',
                  )
                }
              >
                {section.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{section.name}</span>
                <small>{section.conversations.length}</small>
              </button>
            </RosterActions>
            {section.expanded &&
              (section.conversations.length ? (
                section.conversations.map(row)
              ) : (
                <p className="roster-section-empty">{uiText('common:text_5640a5feceb7')}</p>
              ))}
          </section>
        ))}
      {projection.ungrouped.length > 0 && (
        <section className="roster-section" aria-label={uiText('common:text_e86ea3f280d9')}>
          {(projection.sections.length > 0 || projection.pinned.length > 0) && (
            <div className="roster-section-title">
              <span>{uiText('common:text_e86ea3f280d9')}</span>
              <small>{projection.ungrouped.length}</small>
            </div>
          )}
          {projection.ungrouped.map(row)}
        </section>
      )}
      {projection.matchCount === 0 && (
        <div className="search-empty">
          <Search size={24} />
          <p>
            {projection.total === 0
              ? uiText('common:text_6c5e17bc9823')
              : projection.visible.length === 0
                ? uiText('common:text_b43c479392d2')
                : uiText('common:text_d73cc8cbcd38')}
          </p>
          <small>
            {projection.total === 0
              ? uiText('common:text_22ba9f366e79')
              : projection.visible.length === 0
                ? uiText('common:text_bf9223ce2486')
                : uiText('common:text_be85e84ac0b5')}
          </small>
        </div>
      )}
      <div className="roster-list-tools">
        <button
          type="button"
          disabled={locked || (roster.state?.sections.length || 0) >= SIDEBAR_MAX_SECTIONS}
          onClick={() => props.onDialog({ kind: 'create' })}
        >
          <FolderPlus size={15} />
          {uiText('common:text_a810d51d0baa')}
        </button>
        <button
          id="roster-hidden-entry"
          type="button"
          onClick={() => props.onDialog({ kind: 'hidden' })}
        >
          <EyeOff size={15} />
          {uiText('common:text_1f1bc0d5105c')}
          <span>{projection.hidden.length}</span>
        </button>
      </div>
      {!roster.state && <p className="roster-note">{uiText('common:text_9ecc6550aaf7')}</p>}
      {(roster.error || roster.needsSync) && (
        <div className="roster-feedback" role="status">
          <p>{roster.error}</p>
          <button type="button" disabled={roster.busy} onClick={() => void roster.read()}>
            <RefreshCw size={14} />
            {uiText('common:text_65b1ed7d2e28')}
          </button>
        </div>
      )}
    </>
  );
}
export function HiddenRosterEmpty({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="empty-conversation">
      <EyeOff size={42} />
      <h2>{uiText('common:text_b43c479392d2')}</h2>
      <p>{uiText('common:text_02e7e73d420a')}</p>
      <button type="button" className="secondary-button" onClick={onOpen}>
        {uiText('common:text_e9e644e607fb')}
      </button>
    </div>
  );
}

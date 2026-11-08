import { serviceText } from '../../i18n/serviceText';
import { uiText } from '../../i18n';
import {
  BookOpen,
  ChevronRight,
  Copy,
  FolderOpen,
  Link2,
  Loader2,
  MessageCircle,
  Monitor,
  Share2,
  Trash2,
} from 'lucide-react';
import { isSharedBot } from '../../../../shared/shared-bots';
import { conversationVisibility } from '../../approvalUi';
import { Avatar } from '../Avatar';
import { BotProfileFields } from '../BotProfileFields';
import '../BotProfiles.css';
import { Dialog } from '../UI';
import type { useAgentSettingsContent } from './useAgentSettingsContent';
export type AgentSettingsContentModel = ReturnType<typeof useAgentSettingsContent>;
export function AgentSettingsContentView(model: AgentSettingsContentModel) {
  const {
    props,
    navigate,
    draft,
    locked,
    avatarEdits,
    openExistingConversation,
    tab,
    setTab,
    error,
    notice,
    conflict,
    base,
    loadLatest,
    leave,
    setLeave,
    running,
    current,
    save,
    setDraft,
    dirty,
    saving,
    latest,
    confirmDelete,
    setConfirmDelete,
    remove,
  } = model;
  return (
    <Dialog
      title={
        props.readOnly ? uiText('settings:text_653314c99df8') : uiText('settings:text_1f9814883e61')
      }
      subtitle={
        props.readOnly ? uiText('settings:text_89fb12267520') : uiText('settings:text_77cd2da78037')
      }
      className="bot-settings"
      onClose={() => navigate(props.onClose)}
    >
      <div className="bot-settings-preview">
        <Avatar agent={props.readOnly ? props.agent : draft} size={64} />
        <div>
          <h3>
            {(props.readOnly ? props.agent.name : draft.name) ||
              uiText('settings:text_6dbc5ba52ae7')}
          </h3>
          <p>
            {(props.readOnly ? props.agent.role : draft.role) ||
              uiText('settings:text_fecb11bdc571')}
          </p>
        </div>
      </div>
      {props.onOpenConversation && (
        <div className="bot-conversation-entry">
          <button
            type="button"
            className="primary-button"
            disabled={locked || props.conversationAvailable === false || avatarEdits.pending}
            onClick={openExistingConversation}
          >
            <MessageCircle size={16} />
            {props.workspaceKind === 'team'
              ? uiText('settings:text_110ecdb0b777')
              : props.workspaceKind === 'personal' || isSharedBot(props.agent)
                ? uiText('settings:text_d516af068298')
                : uiText('settings:text_550cc20d011a')}
          </button>
          {props.conversationAvailable === false && (
            <p className="field-help">{uiText('settings:text_ccc3c0ad3c42')}</p>
          )}
        </div>
      )}
      {!props.readOnly && (
        <div className="segmented" role="tablist" aria-label={uiText('settings:text_2cd52695bd91')}>
          {(
            [
              ['profile', uiText('settings:text_cba1ec75f4ca')],
              ['instructions', uiText('settings:text_78d18c6b29c7')],
              ['related', uiText('settings:text_3c1917e1c662')],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              role="tab"
              key={value}
              aria-selected={tab === value}
              className={tab === value ? 'active' : ''}
              disabled={locked || avatarEdits.pending}
              onClick={() => {
                if (!avatarEdits.current().pending) setTab(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="bot-form-notice" role="status">
          {notice}
        </p>
      )}
      {(conflict || (props.agent.configRevision !== base.configRevision && !props.readOnly)) && (
        <div className="bot-form-notice">
          <p>{uiText('settings:text_fd4543cdc718')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={locked}
            onClick={() => navigate(() => void loadLatest())}
          >
            {uiText('settings:text_7505e735f011')}
          </button>
        </div>
      )}
      {leave && (
        <div className="bot-form-notice" role="alert">
          <p>{uiText('settings:text_87a752555beb')}</p>
          <div>
            <button type="button" className="secondary-button" onClick={() => setLeave(null)}>
              {uiText('settings:text_fd4b9e3b6c68')}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                if (running.current || !current()) return;
                const work = leave;
                setLeave(null);
                work();
              }}
            >
              {uiText('settings:text_fc0ee8283b68')}
            </button>
          </div>
        </div>
      )}
      {props.readOnly ? (
        <dl className="read-only-details">
          {isSharedBot(props.agent) && (
            <>
              <dt>{uiText('settings:text_7c5465ff0a82')}</dt>
              <dd>
                {props.agent.sharedBot?.ownerName || uiText('settings:text_440712bdcd33')} ·{' '}
                {props.agent.sharedBot?.sourceWorkspaceName || uiText('settings:text_7bee54f565d5')}
                <br />
                {uiText('settings:text_9a6aba0c1dff')}
                {props.agent.sharedBot?.status !== 'active' && (
                  <p className="error-text">
                    {serviceText(props.agent.sharedBot?.reason) ||
                      uiText('settings:text_ece795a2f718')}
                  </p>
                )}
              </dd>
            </>
          )}
          <dt>{uiText('settings:text_8131eafd0239')}</dt>
          <dd>{props.agent.description || uiText('settings:text_1c64182187de')}</dd>
          <dt>{uiText('settings:text_f34d18b15b71')}</dt>
          <dd>{props.agent.instructions || uiText('settings:text_35063da0e928')}</dd>
        </dl>
      ) : (
        tab !== 'related' && (
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <BotProfileFields
              key={avatarEdits.resetKey}
              section={tab}
              draft={draft}
              onChange={setDraft}
              disabled={locked}
              workspaceId={props.workspaceId}
              userId={props.userId}
              onAvatarActivity={(value) => avatarEdits.set('profile', value)}
              onAvatarChange={(patch) => {
                avatarEdits.markChanged();
                setDraft((current) => ({ ...current, ...patch }));
              }}
            />
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={locked}
                onClick={() => navigate(props.onClose)}
              >
                {uiText('settings:text_3fd47edce45b')}
              </button>
              <button
                className="primary-button"
                disabled={locked || avatarEdits.pending || !dirty || conflict}
              >
                {saving && <Loader2 size={15} className="spin" />}
                {uiText('settings:text_ecf0ea01192d')}
              </button>
            </div>
          </form>
        )
      )}
      {(props.readOnly || tab === 'related') && (
        <div className="bot-related">
          {isSharedBot(props.agent) && props.onSharedApps && (
            <button
              type="button"
              disabled={locked}
              onClick={() => navigate(() => latest.current.onSharedApps?.())}
            >
              <Link2 size={18} />
              <span>
                {uiText('settings:text_bd64f94934e2')}
                <small>
                  {props.agent.sharedBot?.appCount || 0}
                  {uiText('settings:text_9c593180aa87')}
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
          )}
          <button type="button" disabled={locked} onClick={() => navigate(props.onComputer)}>
            <Monitor size={18} />
            <span>
              {uiText('settings:text_6205c8a9a2b9')}
              <small>
                {uiText('settings:text_9ae8f7e3040d')}
                {props.agent.name}
                {uiText('settings:text_25d2487b8a6e')}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
          <button type="button" disabled={locked} onClick={() => navigate(props.onSkills)}>
            <BookOpen size={18} />
            <span>
              {uiText('settings:text_b34208d13c8d')}
              <small>
                {props.skillCount}
                {uiText('settings:text_ffccb2a520b0')}{' '}
                {isSharedBot(props.agent)
                  ? uiText('settings:text_5831fa9ae118')
                  : props.readOnly
                    ? uiText('settings:text_a87b2f7e5b9b')
                    : uiText('settings:text_a52f9c6d0314')}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
          <button type="button" disabled={locked} onClick={() => navigate(props.onFiles)}>
            <FolderOpen size={18} />
            <span>
              {uiText('settings:text_5dd8bb5cfc1a')}
              <small>
                {props.fileCount}
                {uiText('settings:text_4080e0d93a3d')}
                {conversationVisibility(props.workspaceKind)}
                {isSharedBot(props.agent) &&
                  uiText('settings:text_3a29016c6d08', {
                    value0: props.agent.sharedBot?.fileCount || 0,
                  })}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
          {!props.readOnly && props.onCopy && (
            <button type="button" disabled={locked} onClick={() => navigate(props.onCopy!)}>
              <Copy size={18} />
              <span>
                {uiText('settings:text_65ee593d33ef')}
                <small>{uiText('settings:text_f40ea1690be2')}</small>
              </span>
              <ChevronRight size={14} />
            </button>
          )}
          {!props.readOnly && props.onShare && (
            <button type="button" disabled={locked} onClick={() => navigate(props.onShare!)}>
              <Share2 size={18} />
              <span>
                {uiText('settings:text_5da82e2bb8b1')}
                <small>{uiText('settings:text_caaf2a6a3f1f')}</small>
              </span>
              <ChevronRight size={14} />
            </button>
          )}
          {!props.readOnly && props.onManageSharing && (
            <button
              type="button"
              disabled={locked}
              onClick={() => navigate(props.onManageSharing!)}
            >
              <Share2 size={18} />
              <span>
                {uiText('settings:text_7c5465ff0a82')}
                <small>{uiText('settings:text_aabdac74e176')}</small>
              </span>
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
      {!props.readOnly && tab === 'related' && (
        <section className="agent-delete-section">
          <h3>{uiText('settings:text_46d14ff760e7')}</h3>
          <p>{uiText('settings:text_1d3d885a1a5d')}</p>
          {props.deleteBlocked && <p className="delete-blocked">{props.deleteBlocked}</p>}
          {props.boundScreen && (
            <button
              type="button"
              className="text-button"
              disabled={locked}
              onClick={() => navigate(props.onComputer)}
            >
              {uiText('settings:text_72e381540dae')}
            </button>
          )}
          {confirmDelete ? (
            <div className="agent-delete-confirm">
              <p>
                {uiText('settings:text_c14525042697')}
                {props.agent.name}
                {uiText('settings:text_27196a39ac16')}
              </p>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => setConfirmDelete(false)}
                >
                  {uiText('settings:text_2cd0f3be8738')}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={locked || !!props.deleteBlocked}
                  onClick={() => void remove()}
                >
                  {saving ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  {uiText('settings:text_c14525042697')}
                  {props.agent.name}
                  {uiText('common:punct_d93a835d0f27')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="text-button delete-agent-link"
              disabled={locked || !!props.deleteBlocked}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={14} />
              {uiText('settings:text_5d7b896fd3cd')}
            </button>
          )}
        </section>
      )}
    </Dialog>
  );
}

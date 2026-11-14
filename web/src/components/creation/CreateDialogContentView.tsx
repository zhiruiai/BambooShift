import { uiText } from '../../i18n';
import { ChevronRight, Loader2, Plus, Sparkles, Users } from 'lucide-react';
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from '../../../../shared/group-members';
import { StarterTemplateCatalog } from '../StarterTemplateCatalog';
import { BotProfileFields } from '../BotProfileFields';
import { CreationBrief } from '../CreationBrief';
import '../BotProfiles.css';
import { GroupRecipients } from '../GroupRecipients';
import { SettingsDialog } from '../SettingsDialog';
import { SmartTeamPanel } from '../SmartTeamPanel';
import { Dialog } from '../UI';
import type { useCreateDialogContent } from './useCreateDialogContent';
export type CreateDialogContentModel = ReturnType<typeof useCreateDialogContent>;
export function CreateDialogContentView(model: CreateDialogContentModel) {
  const {
    view,
    props,
    mode,
    navigate,
    locked,
    creation,
    setChoice,
    setTeamPlanId,
    resetManualDraft,
    leave,
    setLeave,
    running,
    teamLock,
    scope,
    error,
    openCreated,
    saving,
    latest,
    setView,
    teamPlanId,
    setTeamBusy,
    teamDirty,
    create,
    avatarEdits,
    draft,
    canEditManual,
    setDraft,
    manualLocked,
    ids,
    manual,
    setIds,
    groupTitle,
    setCustomTitle,
    setTitle,
    customTitle,
  } = model;
  return (
    <>
      <Dialog
        active={view === 'create'}
        title={
          props.canCreateBot ? uiText('bots:text_c9b8fb3c8582') : uiText('bots:text_60b9878b1841')
        }
        subtitle={uiText('bots:text_2ab15784303b')}
        className="bot-create"
        wide={mode === 'team'}
        onClose={() => navigate(props.onClose)}
      >
        {props.onBrowseShared && (
          <button
            type="button"
            className="secondary-button"
            disabled={locked}
            onClick={() => navigate(props.onBrowseShared!)}
          >
            <Users size={16} />
            {uiText('bots:text_357c867bffdb')}
            <ChevronRight size={14} />
          </button>
        )}
        {props.canCreateBot && !props.botOnly && (
          <div className="segmented" role="tablist" aria-label={uiText('bots:text_7dc7ed46b007')}>
            {(
              [
                ['bot', uiText('bots:text_a25af04e6a9b'), Sparkles],
                ['group', uiText('bots:text_d74b0c1a333c'), Users],
                ['team', uiText('bots:text_5ed92ff52716'), Sparkles],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                type="button"
                role="tab"
                key={value}
                aria-selected={mode === value}
                className={mode === value ? 'active' : ''}
                disabled={locked || !!creation.state.request}
                onClick={() => {
                  if (value === mode || creation.getState().request) return;
                  navigate(() => {
                    setChoice(value);
                    if (value === 'team') setTeamPlanId(undefined);
                    resetManualDraft();
                  });
                }}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        )}
        {leave && (
          <div className="bot-form-notice" role="alert">
            <p>{uiText('bots:text_ee2576bf85b8')}</p>
            <div>
              <button type="button" className="secondary-button" onClick={() => setLeave(null)}>
                {uiText('bots:text_fd4b9e3b6c68')}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  if (running.current || teamLock.current || !scope.current(scope.ticket())) return;
                  const work = leave;
                  setLeave(null);
                  work();
                }}
              >
                {uiText('bots:text_fc0ee8283b68')}
              </button>
            </div>
          </div>
        )}
        {(error || creation.state.error) && (
          <p className="error-text" role="alert">
            {error || creation.state.error}
          </p>
        )}
        {creation.state.message && <p className="bot-form-notice">{creation.state.message}</p>}
        {creation.state.request && (
          <section className="bot-form-notice" aria-label={uiText('bots:text_2c1dcb740409')}>
            {creation.state.receipt ? (
              <>
                <strong>
                  {creation.state.receipt.status === 'created'
                    ? uiText('bots:text_80bfa30db209')
                    : uiText('bots:text_0392d7f55fa2')}
                </strong>
                <p>
                  {creation.state.receipt.status === 'created'
                    ? uiText('bots:text_da5cfaf8bbbf', {
                        value0:
                          creation.state.receipt.conversation?.title ||
                          (creation.state.receipt.kind === 'bot'
                            ? uiText('bots:text_d91dc4020669')
                            : uiText('bots:text_5f30007d1090')),
                      })
                    : uiText('bots:text_fd05fde3f50b')}
                </p>
                <div className="dialog-actions">
                  {creation.state.receipt.status === 'created' && (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={locked}
                      onClick={() => void openCreated()}
                    >
                      {saving && <Loader2 size={15} className="spin" />}
                      {uiText('bots:text_2da0b2a8111d')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => {
                      if (
                        !scope.current(scope.ticket()) ||
                        running.current ||
                        creation.getState().busy
                      )
                        return;
                      if (creation.finish()) resetManualDraft();
                    }}
                  >
                    {uiText('bots:text_32c56a9ef3a2')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <strong>
                  {locked ? uiText('bots:text_794e0d893635') : uiText('bots:text_1d8c44fc204b')}
                </strong>
                <p>{uiText('bots:text_803b01fc62dd')}</p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => void creation.check()}
                  >
                    {uiText('bots:text_d027c9aa232e')}
                  </button>
                  {creation.state.originalAvailable && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        locked ||
                        !creation.state.canRetry ||
                        (creation.state.request.kind === 'bot' && !props.canCreateBot)
                      }
                      onClick={() => {
                        if (
                          creation.getState().request?.kind === 'bot' &&
                          !latest.current.canCreateBot
                        )
                          return;
                        void creation.retry();
                      }}
                    >
                      {uiText('bots:text_aff20ff23ca3')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => void creation.closeRequest()}
                  >
                    {uiText('bots:text_fa79187e51cd')}
                  </button>
                </div>
                <p className="field-help">{uiText('bots:text_5e248577a664')}</p>
              </>
            )}
          </section>
        )}
        {mode === 'bot' && (
          <button
            type="button"
            className="secondary-button starter-trigger"
            disabled={manualLocked || !props.canCreateBot || avatarEdits.pending}
            onClick={model.browseStarters}
          >
            {uiText('workspace:starterBrowse')}
          </button>
        )}
        {mode === 'bot' && props.canCreateBot && props.workspaceId && props.userId && (
          <CreationBrief
            kind="bot"
            active={view === 'create' && !manualLocked && !avatarEdits.pending}
            configured={props.modelConfigured}
            workspaceId={props.workspaceId}
            userId={props.userId}
            onUse={(draft) => {
              if (draft.kind === 'bot') model.chooseStarter(draft.profile);
            }}
          />
        )}
        {mode === 'team' ? (
          <SmartTeamPanel
            agents={props.agents}
            workspaceId={props.workspaceId}
            userId={props.userId}
            modelConfigured={props.modelConfigured || false}
            modelLabel={props.modelLabel || ''}
            disabled={view !== 'create' || !!creation.state.request}
            onConfigureModel={() => {
              if (!scope.current(scope.ticket()) || teamLock.current || running.current) return;
              setView('model-settings');
            }}
            initialPlanId={teamPlanId}
            onBusy={(value) => {
              teamLock.current = value;
              setTeamBusy(value);
            }}
            onDirty={(value) => {
              teamDirty.current = value;
            }}
            onCreated={props.onTeamCreated!}
          />
        ) : (
          <>
            <form
              className="dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              {mode === 'bot' ? (
                <BotProfileFields
                  modelSelection
                  key={avatarEdits.resetKey}
                  draft={draft}
                  onChange={(next) => {
                    if (canEditManual()) setDraft(next);
                  }}
                  disabled={manualLocked}
                  workspaceId={props.workspaceId}
                  userId={props.userId}
                  onAvatarActivity={(value) => avatarEdits.set('profile', value)}
                  onAvatarChange={(patch) => {
                    if (!canEditManual()) return;
                    avatarEdits.markChanged();
                    setDraft((current) => ({ ...current, ...patch }));
                  }}
                />
              ) : (
                <>
                  <GroupRecipients
                    agents={props.agents}
                    ids={ids}
                    disabled={manualLocked}
                    onChange={(next) => {
                      if (canEditManual()) {
                        manual.current = { ...manual.current, ids: next };
                        setIds(next);
                      }
                    }}
                  />
                  <label>
                    {uiText('bots:text_12633e741c9a')}
                    <input
                      required
                      maxLength={100}
                      disabled={manualLocked}
                      value={groupTitle}
                      onChange={(event) => {
                        if (!canEditManual()) return;
                        manual.current = {
                          ...manual.current,
                          customTitle: true,
                          title: event.target.value,
                        };
                        setCustomTitle(true);
                        setTitle(event.target.value);
                      }}
                      placeholder={uiText('bots:text_9c32e5c65412')}
                    />
                  </label>
                  {customTitle && ids.length > 0 && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={manualLocked}
                      onClick={() => {
                        if (canEditManual()) {
                          manual.current = { ...manual.current, customTitle: false, title: '' };
                          setCustomTitle(false);
                          setTitle('');
                        }
                      }}
                    >
                      {uiText('bots:text_856375e847e4')}
                    </button>
                  )}
                </>
              )}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => navigate(props.onClose)}
                >
                  {uiText('bots:text_2cd0f3be8738')}
                </button>
                <button
                  className="primary-button"
                  disabled={
                    manualLocked ||
                    avatarEdits.pending ||
                    (mode === 'group' &&
                      (ids.length < GROUP_MIN_MEMBERS || ids.length > GROUP_MAX_MEMBERS))
                  }
                >
                  {saving ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
                  {uiText('bots:text_cde2cd071d25')}
                  {mode === 'group' ? uiText('bots:text_35b49ee58a4a') : ' Bot'}
                </button>
              </div>
            </form>
          </>
        )}
      </Dialog>
      {view === 'starter-catalog' && (
        <Dialog
          title={uiText('workspace:starterTitle')}
          subtitle={uiText('workspace:starterIntro')}
          wide
          onClose={() => {
            if (scope.current(scope.ticket())) setView('create');
          }}
        >
          <StarterTemplateCatalog
            canCreate={props.canCreateBot}
            disabled={manualLocked}
            current={() => scope.current(scope.ticket())}
            onChoose={model.chooseStarter}
          />
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                if (scope.current(scope.ticket())) setView('create');
              }}
            >
              {uiText('workspace:starterBack')}
            </button>
          </div>
        </Dialog>
      )}
      {view === 'model-settings' && props.settings && (
        <SettingsDialog
          settings={props.settings}
          workspaceId={props.workspaceId}
          userId={props.userId}
          closeLabel={uiText('bots:text_d83450947ea8')}
          onSettingsChanged={(settings) => {
            if (scope.current(scope.ticket())) latest.current.onSettingsChanged?.(settings);
          }}
          onClose={() => {
            if (scope.current(scope.ticket())) setView('create');
          }}
        />
      )}
    </>
  );
}

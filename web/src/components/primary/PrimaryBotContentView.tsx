import { uiText } from '../../i18n';
import { Check, Loader2 } from 'lucide-react';
import { isSharedBot } from '../../../../shared/shared-bots';
import { displayTimeZone as timeZoneLabel } from '../../timeZones';
import { Avatar } from '../Avatar';
import { BotProfileFields } from '../BotProfileFields';
import '../PrimaryBot.css';
import { TimeZoneSelect } from '../TimeZoneSelect';
import { Dialog } from '../UI';
import { PrimaryBotFollowUpStatus } from './parts';
import type { usePrimaryBotContent } from './usePrimaryBotContent';
export type PrimaryBotContentModel = ReturnType<typeof usePrimaryBotContent>;
export function PrimaryBotContentView(model: PrimaryBotContentModel) {
  const {
    navigate,
    props,
    loading,
    base,
    available,
    mode,
    locked,
    review,
    avatarEdits,
    setMode,
    save,
    agentId,
    setAgentId,
    draft,
    setDraft,
    checkIn,
    setCheckIn,
    scope,
    running,
    saving,
    confirmClear,
    setConfirmClear,
    error,
    notice,
    readCurrent,
    observed,
    openCurrent,
    accept,
    leave,
    setLeave,
  } = model;
  return (
    <Dialog
      title={uiText('bots:text_1671a317eae2')}
      subtitle={uiText('bots:text_3b4e40ce5e32')}
      className="primary-bot-dialog bot-create"
      onClose={() => navigate(props.onClose)}
    >
      {loading ? (
        <p className="field-help" role="status">
          <Loader2 size={16} className="spin" />
          {uiText('bots:text_9c697a228db4')}
        </p>
      ) : props.team || (base && !base.available) ? (
        <div className="primary-bot-unavailable">
          <p>
            {props.team || base?.reason === 'team_workspace'
              ? uiText('bots:text_9655b182a74d')
              : uiText('bots:text_015b70e362e5')}
          </p>
          {props.personalHref && (
            <a className="primary-button" href={props.personalHref}>
              {uiText('bots:text_a88158b8268a')}
            </a>
          )}
        </div>
      ) : available ? (
        <>
          <PrimaryBotFollowUpStatus state={props.state} status={props.checkInStatus} />
          <div className="segmented" role="tablist" aria-label={uiText('bots:text_6045d25b234c')}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'select'}
              className={mode === 'select' ? 'active' : ''}
              disabled={locked || review || avatarEdits.pending}
              onClick={() => {
                if (!avatarEdits.current().pending) setMode('select');
              }}
            >
              {uiText('bots:text_a7406d22ea9e')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'create'}
              className={mode === 'create' ? 'active' : ''}
              disabled={locked || review}
              onClick={() => setMode('create')}
            >
              {uiText('bots:text_4fe8c9e54f4f')}
            </button>
          </div>
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {mode === 'select' ? (
              <div
                className="primary-bot-choices"
                role="group"
                aria-label={uiText('bots:text_90720d48efec')}
              >
                {props.agents.some((agent) => !isSharedBot(agent)) ? (
                  props.agents
                    .filter((agent) => !isSharedBot(agent))
                    .map((agent) => (
                      <button
                        type="button"
                        className={`primary-bot-choice ${agentId === agent.id ? 'chosen' : ''}`}
                        aria-pressed={agentId === agent.id}
                        disabled={locked || review}
                        key={agent.id}
                        onClick={() => setAgentId(agent.id)}
                      >
                        <Avatar agent={agent} size={37} />
                        <span>
                          <strong>{agent.name}</strong>
                          <small>{agent.role}</small>
                        </span>
                        {agentId === agent.id && <Check size={16} />}
                      </button>
                    ))
                ) : (
                  <p className="field-help">{uiText('bots:text_9daff14ab627')}</p>
                )}
              </div>
            ) : (
              <BotProfileFields
                key={avatarEdits.resetKey}
                draft={draft}
                onChange={setDraft}
                disabled={locked || review}
                workspaceId={props.workspaceId}
                userId={props.userId}
                onAvatarActivity={(value) => avatarEdits.set('profile', value)}
                onAvatarChange={(patch) => {
                  avatarEdits.markChanged();
                  setDraft((current) => ({ ...current, ...patch }));
                }}
              />
            )}
            <div className="primary-checkin">
              <label className="check-option">
                <input
                  type="checkbox"
                  checked={checkIn.enabled}
                  disabled={locked || review}
                  onChange={(event) =>
                    setCheckIn((value) => ({ ...value, enabled: event.target.checked }))
                  }
                />
                <span>
                  {uiText('bots:text_f4e20f65cd75')}
                  <small>{uiText('bots:text_ac53575297e8')}</small>
                </span>
              </label>
              <label>
                {uiText('bots:text_fb592eec3572')}
                <input
                  type="time"
                  value={checkIn.time}
                  disabled={locked || review || !checkIn.enabled}
                  onChange={(event) =>
                    setCheckIn((value) => ({ ...value, time: event.target.value }))
                  }
                />
              </label>
              <TimeZoneSelect
                value={checkIn.timeZone}
                disabled={locked || review || !checkIn.enabled}
                onChange={(timeZone) => {
                  if (scope.current(scope.ticket()) && !running.current && !locked && !review)
                    setCheckIn((value) => ({ ...value, timeZone }));
                }}
              />
              <p className="field-help">
                {checkIn.enabled
                  ? uiText('bots:text_0434bea1ca24', {
                      value0: checkIn.time || uiText('bots:text_78eac1c7bb8e'),
                      value1: timeZoneLabel(checkIn.timeZone),
                    })
                  : uiText('bots:text_6d14a346ecd2')}
              </p>
            </div>
            <p className="field-help">{uiText('bots:text_b187d28b6336')}</p>
            {!review && (
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => navigate(props.onClose)}
                >
                  {uiText('bots:text_2cd0f3be8738')}
                </button>
                <button className="primary-button" disabled={locked || avatarEdits.pending}>
                  {saving ? <Loader2 size={15} className="spin" /> : null}
                  {mode === 'create'
                    ? uiText('bots:text_38d449759b48')
                    : uiText('bots:text_b6611e21e93c')}
                </button>
              </div>
            )}
          </form>
          {base?.agentId && !review && (
            <div className="primary-clear">
              {confirmClear ? (
                <div className="bot-form-notice">
                  <strong>{uiText('bots:text_551776b60b32')}</strong>
                  <p>{uiText('bots:text_34b82d33da12')}</p>
                  <div>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={locked}
                      onClick={() => setConfirmClear(false)}
                    >
                      {uiText('bots:text_572cf45ba436')}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={locked}
                      onClick={() => void save(true)}
                    >
                      {uiText('bots:text_5ba0e9b41015')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-button"
                  disabled={locked}
                  onClick={() => setConfirmClear(true)}
                >
                  {uiText('bots:text_4a5c95d4624a')}
                </button>
              )}
            </div>
          )}
        </>
      ) : null}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {(review || (!base && !loading)) && (
        <div className="bot-form-notice">
          <p>{notice || uiText('bots:text_98a74b2103de')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={locked}
            onClick={() => void readCurrent()}
          >
            {saving ? uiText('bots:text_6b72c3d6855c') : uiText('bots:text_1ba48cafb80f')}
          </button>
          {observed && (
            <>
              <p>
                {uiText('bots:text_f5cc49a1e91b')}
                {props.agents.find((agent) => agent.id === observed.agentId)?.name ||
                  (observed.agentId
                    ? uiText('bots:text_7f3f16616f9e')
                    : uiText('bots:text_88f6fc489aa1'))}
                {uiText('common:punct_eb0d5884569b')}
              </p>
              <p>
                {observed.checkIn.enabled
                  ? uiText('bots:text_51d4d09366df', {
                      value0: observed.checkIn.time,
                      value1: timeZoneLabel(observed.checkIn.timeZone),
                    })
                  : uiText('bots:text_a188c00c2295')}
              </p>
              <div>
                {observed.agentId && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={locked}
                    onClick={() => navigate(() => void openCurrent(observed))}
                  >
                    {uiText('bots:text_cd72be5a8016')}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => navigate(() => accept(observed))}
                >
                  {uiText('bots:text_99a84ed6f45a')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {leave && (
        <div className="bot-form-notice" role="alert">
          <strong>{uiText('bots:text_bd9007cf9598')}</strong>
          <p>{uiText('bots:text_9bde188ec4a1')}</p>
          <div>
            <button className="secondary-button" type="button" onClick={() => setLeave(null)}>
              {uiText('bots:text_fd4b9e3b6c68')}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                if (!scope.current(scope.ticket()) || running.current) return;
                const work = leave;
                setLeave(null);
                work();
              }}
            >
              {uiText('bots:text_58e5be3a8762')}
            </button>
          </div>
        </div>
      )}
      {!available && !loading && (
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => navigate(props.onClose)}
          >
            {uiText('bots:text_c0b3fbff51cc')}
          </button>
        </div>
      )}
    </Dialog>
  );
}

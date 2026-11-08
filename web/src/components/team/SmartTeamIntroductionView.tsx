import { serviceText } from '../../i18n/serviceText';
import { uiText } from '../../i18n';
import { Loader2, Sparkles } from 'lucide-react';
import '../SmartTeamPanel.css';
import { label, type SmartTeamModel } from './types';
import { TeamStarterPicker } from './TeamStarterPicker';
export function SmartTeamIntroductionView({
  props,
  busy,
  avatarEdits,
  scope,
  running,
  latest,
  error,
  notice,
  uncertain,
  discard,
  setDiscard,
  opening,
  loading,
  choose,
  plan,
  locked,
  startRequest,
  goal,
  setGoal,
  mutate,
}: Pick<
  SmartTeamModel,
  | 'props'
  | 'busy'
  | 'avatarEdits'
  | 'scope'
  | 'running'
  | 'latest'
  | 'error'
  | 'notice'
  | 'uncertain'
  | 'discard'
  | 'setDiscard'
  | 'opening'
  | 'loading'
  | 'choose'
  | 'plan'
  | 'locked'
  | 'startRequest'
  | 'goal'
  | 'setGoal'
  | 'mutate'
>) {
  return (
    <>
      <p className="field-help">{uiText('bots:text_b268540e886c')}</p>
      <p className="field-help">
        {props.modelConfigured
          ? uiText('bots:text_f34698a518ad', {
              value0: props.modelLabel || uiText('bots:text_a02720c41642'),
            })
          : uiText('bots:text_661a180e5ae6')}
      </p>
      {!props.modelConfigured && props.onConfigureModel && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !!props.disabled || avatarEdits.busy}
          onClick={() => {
            if (
              !scope.current(scope.ticket()) ||
              running.current ||
              latest.current.props.disabled ||
              avatarEdits.current().busy
            )
              return;
            latest.current.props.onConfigureModel?.();
          }}
        >
          {uiText('bots:text_dbd3596e4a86')}
        </button>
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
      {uncertain && <div className="bot-form-notice">{uiText('bots:text_5569c5da8d5d')}</div>}
      {discard && (
        <div className="bot-form-notice">
          <p>{uiText('bots:text_310a2cdc4f6e')}</p>
          <div>
            <button type="button" className="secondary-button" onClick={() => setDiscard(null)}>
              {uiText('bots:text_fd4b9e3b6c68')}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                const work = discard;
                setDiscard(null);
                work();
              }}
            >
              {uiText('bots:text_fc0ee8283b68')}
            </button>
          </div>
        </div>
      )}
      {opening && (
        <div className="bot-form-notice" role="status">
          <p>{loading ? uiText('bots:text_e8fb7d744234') : uiText('bots:text_97b8589ed4af')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => choose()}
          >
            {uiText('bots:text_5fd90f9ac755')}
          </button>
        </div>
      )}
      {!opening && (!plan || plan.status === 'error' || plan.status === 'cancelled') && (
        <div className="dialog-form">
          <TeamStarterPicker
            disabled={locked || loading || (!!startRequest.current && !plan)}
            onUse={(starter) => void mutate('start', starter)}
          />
          <label>
            {uiText('bots:text_816a89087df7')}
            <textarea
              rows={4}
              maxLength={6000}
              disabled={locked || (!!startRequest.current && !plan)}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder={uiText('bots:text_bc2df65e2b87')}
            />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={
              locked ||
              loading ||
              (!startRequest.current?.template && (!goal.trim() || !props.modelConfigured))
            }
            onClick={() => void mutate('start')}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
            {plan
              ? uiText('bots:text_9fd11b09c4b0')
              : startRequest.current
                ? uiText('bots:text_7733cdf31345')
                : uiText('bots:text_33358ea865a9')}
          </button>
        </div>
      )}
      {plan && (
        <div className="smart-team-status">
          <span className="pill">{label(plan.status)}</span>
          <p>{plan.goal}</p>
          {plan.error && <p className="error-text">{serviceText(plan.error)}</p>}
          {plan.status === 'generating' && (
            <p className="field-help">
              <Loader2 size={14} className="spin" />
              {uiText('bots:text_c335b96a39ce')}
            </p>
          )}
        </div>
      )}
    </>
  );
}

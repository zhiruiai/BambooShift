import { uiText } from '../../i18n';
import { RefreshCw } from 'lucide-react';
import '../SmartTeamPanel.css';
import { label, type SmartTeamModel } from './types';
export function SmartTeamHistoryView({
  plan,
  busy,
  enter,
  loading,
  read,
  locked,
  mutate,
  choose,
  showHistory,
  history,
}: Pick<
  SmartTeamModel,
  | 'plan'
  | 'busy'
  | 'enter'
  | 'loading'
  | 'read'
  | 'locked'
  | 'mutate'
  | 'choose'
  | 'showHistory'
  | 'history'
>) {
  return (
    <>
      {plan?.status === 'committed' && plan.result && (
        <div className="bot-form-notice">
          <strong>
            {plan.draft?.title || uiText('bots:text_6ff2860ad037')}
            {uiText('bots:text_80bfa30db209')}
          </strong>
          <p>
            {plan.result.memberAgentIds.length}
            {uiText('bots:text_d0715ae01fbb')}
            {plan.result.createdAgentIds.length} {uiText('bots:text_bba8fe106965')}
          </p>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void enter(false)}
            >
              {uiText('bots:text_3a104d9d83e1')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void enter(true)}
            >
              {uiText('bots:text_be3cab435c83')}
            </button>
          </div>
          <p>{uiText('bots:text_e5cb2079e905')}</p>
        </div>
      )}
      <div className="smart-team-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || loading}
          onClick={() => void read()}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          {uiText('bots:text_90b0a90e2226')}
        </button>
        {plan && ['generating', 'ready'].includes(plan.status) && (
          <button
            type="button"
            className="secondary-button"
            disabled={locked}
            onClick={() => void mutate('cancel')}
          >
            {uiText('bots:text_2899840a9992')}
          </button>
        )}
        {plan && !['generating', 'ready'].includes(plan.status) && (
          <button
            type="button"
            className="secondary-button"
            disabled={locked}
            onClick={() => choose()}
          >
            {uiText('bots:text_f4a807140898')}
          </button>
        )}
      </div>
      {showHistory && history.length > 0 && (
        <section className="smart-team-history">
          <h3>{uiText('bots:text_28ce2db4829e')}</h3>
          {history.map((item) => (
            <button type="button" key={item.id} disabled={locked} onClick={() => choose(item)}>
              <span>
                <strong>{item.draft?.title || item.goal.slice(0, 60)}</strong>
                <small>{label(item.status)}</small>
              </span>
            </button>
          ))}
        </section>
      )}
    </>
  );
}

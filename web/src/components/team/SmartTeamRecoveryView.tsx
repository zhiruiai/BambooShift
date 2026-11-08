import { uiText } from '../../i18n';
import '../SmartTeamPanel.css';
import { type SmartTeamModel } from './types';
export function SmartTeamRecoveryView({
  catalogRequest,
  busy,
  props,
  checkCatalogRequest,
  saveCatalog,
  catalogSavedPlan,
  continueSavedCatalog,
}: Pick<
  SmartTeamModel,
  | 'catalogRequest'
  | 'busy'
  | 'props'
  | 'checkCatalogRequest'
  | 'saveCatalog'
  | 'catalogSavedPlan'
  | 'continueSavedCatalog'
>) {
  return (
    <>
      {catalogRequest && (
        <section
          className="smart-team-catalog bot-form-notice"
          aria-label={uiText('bots:text_4bc50367795d')}
        >
          <h3>{uiText('bots:text_2033b5963cdb')}</h3>
          <p>{uiText('bots:text_1df5214a7e73')}</p>
          <div className="smart-team-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !!props.disabled}
              onClick={() => void checkCatalogRequest()}
            >
              {uiText('bots:text_38ec197a5eb4')}
            </button>
            {catalogRequest.body && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !!props.disabled}
                onClick={() => void saveCatalog(true)}
              >
                {uiText('bots:text_1101d9631942')}
              </button>
            )}
          </div>
          {catalogSavedPlan && (
            <div className="smart-team-catalog-saved">
              <h4>{uiText('bots:text_1d16b6ee1721')}</h4>
              <p>{catalogSavedPlan.goal}</p>
              <strong>{catalogSavedPlan.draft?.title || uiText('bots:text_0ef7963defcf')}</strong>
              <p>{catalogSavedPlan.draft?.summary}</p>
              {catalogSavedPlan.draft?.members.map((member) => (
                <details key={member.key}>
                  <summary>
                    {member.kind === 'create'
                      ? member.name
                      : props.agents.find((agent) => agent.id === member.agentId)?.name ||
                        uiText('bots:text_8413aee05ac8')}
                    {catalogSavedPlan.draft?.leadKey === member.key
                      ? uiText('bots:text_9705e0c25464')
                      : ''}
                  </summary>
                  <p>{member.assignment}</p>
                  {member.kind === 'create' && (
                    <>
                      <p>{member.role}</p>
                      <p>{member.description}</p>
                      <pre>{member.instructions}</pre>
                    </>
                  )}
                </details>
              ))}
              <p>
                {catalogRequest.body
                  ? uiText('bots:text_2dbd7b73eb51')
                  : uiText('bots:text_f4057115606d')}
              </p>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !!props.disabled}
                onClick={() => void continueSavedCatalog()}
              >
                {catalogRequest.body
                  ? uiText('bots:text_04f6e1183ccd')
                  : uiText('bots:text_89b4aba4a3f6')}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

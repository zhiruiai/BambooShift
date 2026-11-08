import { uiText } from '../../i18n';
import { Loader2, RefreshCw } from 'lucide-react';
import { Avatar } from '../Avatar';
import '../SmartTeamPanel.css';
import { type SmartTeamModel } from './types';
export function SmartTeamCatalogView({
  draft,
  locked,
  loading,
  catalogLoading,
  avatarEdits,
  commitRequest,
  reviewBots,
  catalogPreview,
  props,
  saveCatalog,
}: Pick<
  SmartTeamModel,
  | 'draft'
  | 'locked'
  | 'loading'
  | 'catalogLoading'
  | 'avatarEdits'
  | 'commitRequest'
  | 'reviewBots'
  | 'catalogPreview'
  | 'props'
  | 'saveCatalog'
>) {
  if (!draft) return null;
  return (
    <>
      <section className="smart-team-catalog" aria-label={uiText('bots:text_c9b98a14d5a3')}>
        <h3>{uiText('bots:text_8e135b83a488')}</h3>
        <p className="field-help">{uiText('bots:text_399f8b70560c')}</p>
        {draft.members.some((member) => member.kind === 'reuse') ? (
          <button
            type="button"
            className="secondary-button"
            disabled={
              locked || loading || catalogLoading || avatarEdits.pending || !!commitRequest.current
            }
            onClick={() => void reviewBots()}
          >
            {catalogLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {catalogLoading ? uiText('bots:text_34fbe0cbd5b9') : uiText('bots:text_8e135b83a488')}
          </button>
        ) : (
          <p className="field-help">{uiText('bots:text_834b02fe7fbd')}</p>
        )}
        {catalogPreview && (
          <div className="smart-team-catalog-preview">
            {catalogPreview.value.members.map((member) => (
              <article key={member.key}>
                <header>
                  <Avatar agent={member.profile} size={36} userId={props.userId} />
                  <div>
                    <strong>{member.profile.name}</strong>
                    <p>{member.profile.role}</p>
                  </div>
                  <span className="pill">
                    {
                      {
                        added: uiText('bots:text_0006d696d8e1'),
                        changed: uiText('bots:text_c6a51069df9a'),
                        unchanged: uiText('bots:text_0680a4a36ca8'),
                      }[member.state]
                    }
                  </span>
                </header>
                {member.profile.sharedBot && (
                  <p className="field-help">
                    {uiText('bots:text_fd4e0ab45e27')}
                    {member.profile.sharedBot.ownerName}
                  </p>
                )}
                <details>
                  <summary>{uiText('bots:text_57f34bfdf79d')}</summary>
                  <dl>
                    <dt>{uiText('bots:text_8131eafd0239')}</dt>
                    <dd>{member.profile.description || uiText('bots:text_6b4f7470759c')}</dd>
                    <dt>{uiText('bots:text_f34d18b15b71')}</dt>
                    <dd>{member.profile.instructions || uiText('bots:text_e4106468564f')}</dd>
                  </dl>
                </details>
              </article>
            ))}
            <p className="field-help">{uiText('bots:text_c5921c780f77')}</p>
            <button
              type="button"
              className="secondary-button"
              disabled={locked || avatarEdits.pending || !!commitRequest.current}
              onClick={() => void saveCatalog()}
            >
              {uiText('bots:text_a57be6f102cb')}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

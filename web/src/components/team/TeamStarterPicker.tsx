import { useState } from 'react';
import { Layers3 } from 'lucide-react';
import type { BotTeamDraft, CreateBotTeamPlan } from '../../../../shared/bot-team-plans';
import catalog from '../../../../shared/team-starter-templates.json';
import { currentLanguage, uiText } from '../../i18n';
import '../SmartTeamPanel.css';

type TeamStarter = { id: string; draft: BotTeamDraft };
export type TeamStarterSelection = NonNullable<CreateBotTeamPlan['template']> & { summary: string };

export function TeamStarterPicker({
  disabled,
  onUse,
}: {
  disabled: boolean;
  onUse: (selection: TeamStarterSelection) => void;
}) {
  const [id, setId] = useState('');
  const language = currentLanguage();
  const teams = catalog[language] as TeamStarter[];
  const selected = teams.find((team) => team.id === id);
  return (
    <section className="team-starter-picker" aria-label={uiText('workspace:teamStarterTitle')}>
      <div className="team-starter-heading">
        <Layers3 size={17} aria-hidden="true" />
        <h3>{uiText('workspace:teamStarterTitle')}</h3>
      </div>
      <p className="field-help">{uiText('workspace:teamStarterHelp')}</p>
      <div className="team-starter-options">
        {teams.map((team) => (
          <button
            type="button"
            className="secondary-button"
            key={team.id}
            aria-pressed={id === team.id}
            disabled={disabled}
            onClick={() => setId(id === team.id ? '' : team.id)}
          >
            {team.draft.title}
          </button>
        ))}
      </div>
      {selected && (
        <>
          <p>{selected.draft.summary}</p>
          <ul className="team-starter-roles">
            {selected.draft.members.map((member) =>
              member.kind === 'create' ? (
                <li key={member.key}>
                  <strong>{member.name}</strong>
                  <p>{member.assignment}</p>
                </li>
              ) : null,
            )}
          </ul>
          <button
            type="button"
            className="primary-button"
            disabled={disabled}
            onClick={() => onUse({ id: selected.id, language, summary: selected.draft.summary })}
          >
            {uiText('workspace:teamStarterUse')}
          </button>
        </>
      )}
    </section>
  );
}

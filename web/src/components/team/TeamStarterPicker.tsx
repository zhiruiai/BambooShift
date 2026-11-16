import { useState } from 'react';
import {
  BookOpen,
  Calculator,
  ChevronRight,
  ClipboardList,
  Headphones,
  Layers3,
  Rocket,
  Video,
} from 'lucide-react';
import type { BotTeamDraft, CreateBotTeamPlan } from '../../../../shared/bot-team-plans';
import catalog from '../../../../shared/team-starter-templates.json';
import { currentLanguage, uiText } from '../../i18n';
import { starterTeamMemberPacks } from '../../starterSkillPacks';
import '../SmartTeamPanel.css';

const starterIcons = {
  launch: Rocket,
  close: Calculator,
  support: Headphones,
  study: BookOpen,
  creator: Video,
  office: ClipboardList,
};

type TeamStarter = { id: string; draft: BotTeamDraft };
export type TeamStarterSelection = NonNullable<CreateBotTeamPlan['template']> & { summary: string };

export function TeamStarterPicker({
  disabled,
  onUse,
  onUseAndOpen,
  hideHeading,
}: {
  disabled: boolean;
  onUse?: (selection: TeamStarterSelection) => void;
  onUseAndOpen?: (selection: TeamStarterSelection, reviewedDraft: BotTeamDraft) => void;
  hideHeading?: boolean;
}) {
  const [id, setId] = useState('');
  const language = currentLanguage();
  const teams = catalog[language] as TeamStarter[];
  const selected = teams.find((team) => team.id === id);
  return (
    <section className="team-starter-picker" aria-label={uiText('workspace:teamStarterTitle')}>
      {!hideHeading && (
        <div className="team-starter-heading">
          <Layers3 size={17} aria-hidden="true" />
          <h3>{uiText('workspace:teamStarterTitle')}</h3>
        </div>
      )}
      {(onUse || onUseAndOpen) && (
        <p className="field-help">{uiText('workspace:teamStarterHelp')}</p>
      )}
      <div className="team-starter-options">
        {teams.map((team) => {
          const Icon = starterIcons[team.id as keyof typeof starterIcons] ?? Layers3;
          return (
            <button
              type="button"
              className="team-starter-option"
              key={team.id}
              aria-pressed={id === team.id}
              disabled={disabled}
              onClick={() => setId(id === team.id ? '' : team.id)}
            >
              <span className="team-starter-option-icon">
                <Icon size={17} aria-hidden="true" />
              </span>
              <strong>{team.draft.title}</strong>
              <ChevronRight className="team-starter-option-arrow" size={15} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {selected && (
        <div className="team-starter-preview" aria-label={selected.draft.title}>
          <p className="team-starter-summary">{selected.draft.summary}</p>
          <ul className="team-starter-roles">
            {selected.draft.members.map((member) => {
              if (member.kind !== 'create') return null;
              const skills = starterTeamMemberPacks(selected.id, member.key, language);
              return (
                <li key={member.key}>
                  <strong>{member.name}</strong>
                  {selected.draft.leadKey === member.key && (
                    <span>{uiText('workspace:teamStarterLead')}</span>
                  )}
                  <span>{member.role}</span>
                  <p>{member.assignment}</p>
                  {skills.length > 0 && (
                    <p>
                      {uiText('workspace:starterIncludedSkills', {
                        names: skills.map((pack) => pack.name).join(' · '),
                      })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {(onUse || onUseAndOpen) && (
            <div className="smart-team-actions">
              {onUseAndOpen && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={disabled}
                  onClick={() =>
                    onUseAndOpen(
                      { id: selected.id, language, summary: selected.draft.summary },
                      selected.draft,
                    )
                  }
                >
                  {uiText('workspace:teamStarterUseAndOpen')}
                </button>
              )}
              {onUse && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() =>
                    onUse({ id: selected.id, language, summary: selected.draft.summary })
                  }
                >
                  {uiText('workspace:teamStarterUse')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

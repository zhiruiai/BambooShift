import { ArrowLeft, BookOpen, ChevronRight, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BotAgent } from '../../../../shared/types';
import { currentLanguage, uiText } from '../../i18n';
import { skillWorkflowTemplates, type PackagedSkillDraft } from '../../skillWorkflowTemplates';
import { Markdown } from '../Markdown';
import './PrivateSkills.css';
import './PackagedSkills.css';

export function PackagedSkillsCatalog({
  bots,
  canEdit,
  disabled,
  onEdit,
  initialAgentId,
  embedded = false,
}: {
  bots: readonly Pick<BotAgent, 'id' | 'name'>[];
  canEdit: boolean;
  disabled: boolean;
  onEdit: (draft: PackagedSkillDraft) => void;
  initialAgentId?: string;
  embedded?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [target, setTarget] = useState(initialAgentId || '');
  const scroll = useRef<HTMLDivElement>(null);
  const previewBack = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const returning = useRef(false);
  const recipes = skillWorkflowTemplates[currentLanguage()];
  const recipe = recipes.find(({ id }) => id === selected);
  const selectedBot = bots.find(({ id }) => id === target);
  const query = search.trim().toLocaleLowerCase();
  const matches = recipes.filter(({ id, name, description }) =>
    `${id} ${name} ${description}`.toLocaleLowerCase().includes(query),
  );

  useEffect(() => {
    if (embedded) scroll.current?.scrollIntoView({ block: 'start' });
    else if (scroll.current) scroll.current.scrollTop = 0;
    if (selected) previewBack.current?.focus({ preventScroll: true });
    else if (returning.current) searchInput.current?.focus({ preventScroll: true });
  }, [selected, embedded]);

  return (
    <div
      className={`${embedded ? 'packaged-skills-embedded' : 'apps-scroll'} packaged-skills`}
      ref={scroll}
    >
      {recipe ? (
        <section className="private-skill-review" aria-label={recipe.name}>
          <div className="private-skills-toolbar">
            <button
              ref={previewBack}
              type="button"
              className="text-button"
              onClick={() => {
                returning.current = true;
                setSelected('');
              }}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              {uiText('workspace:packagedSkillsBack')}
            </button>
          </div>
          <h3>{recipe.name}</h3>
          <p className="field-help">{recipe.description}</p>
          <div className="skill-content packaged-skill-content">
            <Markdown text={recipe.content} passive />
          </div>
          <p className="field-help">{uiText('workspace:packagedSkillsApproval')}</p>
          {canEdit ? (
            bots.length ? (
              <div className="private-skill-target">
                <label>
                  {uiText('workspace:packagedSkillsChooseBot')}
                  <select
                    value={target}
                    disabled={disabled}
                    onChange={(event) => setTarget(event.target.value)}
                  >
                    <option value="" disabled>
                      {uiText('workspace:packagedSkillsChooseBot')}
                    </option>
                    {bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="primary-button"
                  disabled={disabled || !selectedBot}
                  onClick={() => selectedBot && onEdit({ agentId: selectedBot.id, recipe })}
                >
                  {uiText('workspace:packagedSkillsEdit')}
                </button>
              </div>
            ) : (
              <p className="field-help">{uiText('workspace:packagedSkillsNoBots')}</p>
            )
          ) : (
            <p className="field-help">{uiText('workspace:packagedSkillsReadOnly')}</p>
          )}
        </section>
      ) : (
        <>
          <div className="private-skills-toolbar">
            <label className="apps-search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchInput}
                type="search"
                value={search}
                maxLength={120}
                aria-label={uiText('workspace:packagedSkillsSearch')}
                placeholder={uiText('workspace:packagedSkillsSearch')}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          {matches.length ? (
            <ul className="private-skill-list">
              {matches.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="integration"
                    aria-label={uiText('workspace:packagedSkillsPreviewNamed', {
                      name: entry.name,
                    })}
                    onClick={() => {
                      setSelected(entry.id);
                      setTarget(initialAgentId || '');
                    }}
                  >
                    <span className="integration-icon lavender" aria-hidden="true">
                      <BookOpen size={17} />
                    </span>
                    <span>
                      <strong>{entry.name}</strong>
                      <small>{entry.description}</small>
                      <small>{uiText('workspace:packagedSkillsPreview')}</small>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="field-help">
              {uiText('workspace:packagedSkillsEmpty')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

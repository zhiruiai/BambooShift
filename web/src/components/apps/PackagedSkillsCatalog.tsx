import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotAgent, Skill } from '../../../../shared/types';
import { currentLanguage, uiText } from '../../i18n';
import { skillWorkflowPackage, skillWorkflowTemplates } from '../../skillWorkflowTemplates';
import { skillStatusLabel } from '../../skillVersions';
import { SkillInstallation } from '../SkillInstallation';
import type { InstallSkill } from '../../skillInstallation';
import './PackagedSkills.css';

function visibleSkillCount() {
  if (typeof window === 'undefined') return 6;
  if (window.matchMedia('(max-width: 760px)').matches)
    return window.matchMedia('(max-height: 640px)').matches ? 2 : 3;
  return window.matchMedia('(min-width: 1000px) and (min-height: 720px)').matches ? 9 : 6;
}

export function PackagedSkillsCatalog({
  bots,
  canEdit,
  disabled,
  onInstall,
  onBusyChange,
  onInstalled,
  initialAgentId,
  embedded = false,
  skills = [],
  onExit,
  exitLabel,
}: {
  bots: readonly Pick<BotAgent, 'id' | 'name'>[];
  canEdit: boolean;
  disabled: boolean;
  onInstall?: InstallSkill;
  onBusyChange?: (busy: boolean) => void;
  onInstalled?: () => void;
  initialAgentId?: string;
  embedded?: boolean;
  skills?: readonly Skill[];
  onExit?: () => void;
  exitLabel?: string;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(visibleSkillCount);
  const [selected, setSelected] = useState('');
  const target = initialAgentId || (bots.length === 1 ? bots[0].id : '');
  const scroll = useRef<HTMLDivElement>(null);
  const previewBack = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const returning = useRef(false);
  const language = currentLanguage();
  const recipes = skillWorkflowTemplates[language];
  const recipe = recipes.find(({ id }) => id === selected);
  const workflow = useMemo(
    () => recipe && skillWorkflowPackage(recipe, language),
    [recipe, language],
  );
  const selectedBot = bots.find(({ id }) => id === target);
  const botSkills = new Map<string, 'active' | 'proposed'>();
  for (const skill of skills) {
    if (skill.agentId !== selectedBot?.id) continue;
    const root = skill.skillPackage?.root ?? skill.name;
    if (skill.status === 'active' || (skill.status === 'proposed' && !botSkills.has(root)))
      botSkills.set(root, skill.status);
  }
  const words = search.trim().toLocaleLowerCase(language).split(/\s+/u);
  const matches = recipes.filter(({ id, name, description }) => {
    const text = `${id} ${name} ${description}`.toLocaleLowerCase(language);
    return words.every((word) => text.includes(word));
  });
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  useEffect(() => {
    const queries = [
      window.matchMedia('(max-width: 760px)'),
      window.matchMedia('(max-height: 640px)'),
      window.matchMedia('(min-width: 1000px) and (min-height: 720px)'),
    ];
    const resize = () => {
      setPageSize(visibleSkillCount());
      setPage(0);
    };
    queries.forEach((query) => query.addEventListener('change', resize));
    return () => queries.forEach((query) => query.removeEventListener('change', resize));
  }, []);

  useEffect(() => {
    if (embedded) scroll.current?.closest('.modal-body')?.scrollTo({ top: 0 });
    else if (scroll.current) scroll.current.scrollTop = 0;
    if (selected) previewBack.current?.focus({ preventScroll: true });
    else if (returning.current || (embedded && window.matchMedia('(pointer: fine)').matches))
      searchInput.current?.focus({ preventScroll: true });
  }, [selected, embedded]);

  return (
    <div
      className={`${embedded ? 'packaged-skills-embedded' : 'apps-scroll'} packaged-skills`}
      ref={scroll}
    >
      {recipe && workflow ? (
        <section className="packaged-skill-preview" aria-label={recipe.name}>
          <div className="packaged-skills-navigation">
            <button
              ref={previewBack}
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => {
                returning.current = true;
                setSelected('');
              }}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              {uiText('workspace:packagedSkillsBack')}
            </button>
          </div>
          <header className="packaged-skill-heading">
            <span className="packaged-skill-icon" aria-hidden="true">
              <BookOpen size={19} />
            </span>
            <div>
              <h3>{recipe.name}</h3>
              <p>{recipe.description}</p>
            </div>
          </header>
          <SkillInstallation
            key={recipe.id}
            skill={workflow.draft}
            fileContents={workflow.fileContents}
            bots={bots}
            skills={skills}
            initialAgentId={initialAgentId}
            canEdit={canEdit}
            disabled={disabled}
            onInstall={onInstall}
            onBusyChange={onBusyChange}
            onDone={() => {
              if (onInstalled) onInstalled();
              else {
                returning.current = true;
                setSelected('');
              }
            }}
          />
        </section>
      ) : (
        <>
          <div className="packaged-skills-navigation">
            {onExit && (
              <button type="button" className="text-button" disabled={disabled} onClick={onExit}>
                <ArrowLeft size={14} aria-hidden="true" />
                {exitLabel || uiText('settings:botSkillsCatalogBack')}
              </button>
            )}
            <label className="packaged-skills-search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchInput}
                type="search"
                value={search}
                maxLength={120}
                aria-label={uiText('workspace:packagedSkillsSearch')}
                placeholder={uiText('workspace:packagedSkillsSearch')}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </label>
          </div>
          {matches.length ? (
            <ul className="packaged-skill-grid">
              {visible.map((entry) => {
                const state = botSkills.get(entry.id);
                const label = state && skillStatusLabel(state);
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="packaged-skill-tile"
                      aria-label={uiText('workspace:packagedSkillsPreviewNamed', {
                        name: entry.name,
                      })}
                      aria-description={
                        label ? `${label}. ${entry.description}` : entry.description
                      }
                      onClick={() => setSelected(entry.id)}
                    >
                      <strong>{entry.name}</strong>
                      <ChevronRight size={14} aria-hidden="true" />
                      <span className="packaged-skill-summary">{entry.description}</span>
                      {label && <span className="packaged-skill-status">{label}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p role="status" className="field-help">
              {uiText('workspace:packagedSkillsEmpty')}
            </p>
          )}
          {matches.length > 0 && (
            <nav
              className="packaged-skills-pages"
              aria-label={uiText('workspace:packagedSkillsPages')}
            >
              <span role="status">
                {uiText('workspace:packagedSkillsPage', {
                  count: matches.length,
                  page: currentPage + 1,
                  total: pageCount,
                })}
              </span>
              {pageCount > 1 && (
                <div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={uiText('workspace:packagedSkillsPrevious')}
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={uiText('workspace:packagedSkillsNext')}
                    disabled={currentPage === pageCount - 1}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}

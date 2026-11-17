import { ChevronLeft, ChevronRight, Search, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BotAgent, Skill } from '../../../shared/types';
import { uiText } from '../i18n';
import { skillDisplayName, skillVersionsInView, type SkillView } from '../skillVersions';
import { SkillManagerDetail } from './SkillManagerDetail';
import './SkillManager.css';

function usePageSize(compact: boolean) {
  const read = () =>
    window.matchMedia('(max-width: 760px)').matches
      ? window.matchMedia('(max-height: 680px)').matches
        ? 2
        : 3
      : window.matchMedia('(max-height: 700px)').matches
        ? 4
        : 6;
  const [size, setSize] = useState(read);
  useEffect(() => {
    const queries = ['(max-width: 760px)', '(max-height: 680px)', '(max-height: 700px)'].map(
      (query) => window.matchMedia(query),
    );
    const update = () => setSize(read());
    queries.forEach((query) => query.addEventListener('change', update));
    return () => queries.forEach((query) => query.removeEventListener('change', update));
  }, []);
  return Math.max(1, size - (compact ? 1 : 0));
}

export function SkillManager({
  skills,
  agents,
  view,
  disabled,
  onView,
  canEdit,
  onReview,
  initialSelection = '',
  compact = false,
}: {
  skills: Skill[];
  agents: BotAgent[];
  view: SkillView;
  disabled: boolean;
  onView: (view: SkillView) => void;
  canEdit: (skill: Skill) => boolean;
  onReview: (skillId: string) => void;
  initialSelection?: string;
  compact?: boolean;
}) {
  const [selectedId, setSelected] = useState(initialSelection);
  const [detailOpen, setDetailOpen] = useState(!!initialSelection);
  const [query, setQuery] = useState('');
  const pageSize = usePageSize(compact);
  const skillsInView = skillVersionsInView(skills, view);
  const [page, setPage] = useState(() =>
    Math.max(
      0,
      Math.floor(skillsInView.findIndex((skill) => skill.id === initialSelection) / pageSize),
    ),
  );
  const list = useRef<HTMLUListElement>(null);
  const filtered = skillsInView.filter((skill) =>
    [
      skillDisplayName(skill),
      skill.name,
      skill.description,
      agents.find((agent) => agent.id === skill.agentId)?.name,
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = filtered.find((skill) => skill.id === selectedId) || visible[0];
  const selectedIndex = filtered.findIndex((skill) => skill.id === selectedId);
  useEffect(() => {
    if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / pageSize));
  }, [pageSize, selectedIndex]);
  const tabs = [
    ['current', uiText('common:text_5ddff4afab27')],
    ['proposals', uiText('common:text_a8b0bd9c65f7')],
    ['history', uiText('common:text_6fd29579ab66')],
  ] as const;
  return (
    <section
      className="skill-manager"
      data-detail-open={detailOpen && !!selected}
      aria-label={uiText(
        agents.length === 1 ? 'settings:botSkillsLabel' : 'common:text_2c38f222bfa4',
      )}
    >
      <div className="skill-browser">
        <label className="skill-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label={uiText('settings:skillSearch')}
            placeholder={uiText('settings:skillSearch')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
              setSelected('');
              setDetailOpen(false);
            }}
          />
        </label>
        <div
          className="skill-version-tabs"
          role="group"
          aria-label={uiText('common:text_1d724da1aa0c')}
        >
          {tabs.map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-pressed={view === id}
              disabled={disabled}
              onClick={() => {
                onView(id);
                setPage(0);
                setSelected('');
                setDetailOpen(false);
              }}
            >
              <span>{label}</span>
              <small>{skillVersionsInView(skills, id).length}</small>
            </button>
          ))}
        </div>
        {visible.length ? (
          <ul className="skill-manager-list" ref={list}>
            {visible.map((skill) => (
              <li key={skill.id}>
                <button
                  type="button"
                  className="skill-picker"
                  data-skill-id={skill.id}
                  aria-current={selected?.id === skill.id ? 'true' : undefined}
                  onClick={() => {
                    setSelected(skill.id);
                    setDetailOpen(true);
                  }}
                >
                  <span className="resource-icon lavender" aria-hidden="true">
                    <Sparkles size={17} />
                  </span>
                  <span className="skill-picker-copy">
                    <strong>{skillDisplayName(skill)}</strong>
                    <small>
                      v{skill.version} ·{' '}
                      {agents.find((agent) => agent.id === skill.agentId)?.name ||
                        uiText('common:text_25536a7889ed')}
                    </small>
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="skill-manager-empty">
            <Sparkles size={19} aria-hidden="true" />
            <p>
              {query.trim()
                ? uiText('settings:skillSearchEmpty')
                : uiText(
                    view === 'current'
                      ? 'common:text_6c1973ebd192'
                      : view === 'proposals'
                        ? 'common:text_75ad326d6613'
                        : 'common:text_f2ae7b5e827e',
                  )}
            </p>
          </div>
        )}
        <div className="skill-pagination">
          <span role="status">
            {uiText('settings:skillPage', { page: currentPage + 1, pages, count: filtered.length })}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={uiText('settings:skillPreviousPage')}
            disabled={currentPage === 0}
            onClick={() => {
              setPage(currentPage - 1);
              setSelected('');
            }}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={uiText('settings:skillNextPage')}
            disabled={currentPage + 1 >= pages}
            onClick={() => {
              setPage(currentPage + 1);
              setSelected('');
            }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      {selected ? (
        <SkillManagerDetail
          key={selected.id}
          skill={selected}
          agentName={
            agents.find((agent) => agent.id === selected.agentId)?.name ||
            uiText('common:text_25536a7889ed')
          }
          disabled={disabled}
          editable={canEdit(selected)}
          focus={detailOpen}
          onReview={() => onReview(selected.id)}
          onBack={() => {
            setDetailOpen(false);
            requestAnimationFrame(() =>
              list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus(),
            );
          }}
        />
      ) : (
        <div className="skill-detail-empty">
          <Sparkles size={28} aria-hidden="true" />
          <p>{uiText('settings:skillChooseDetail')}</p>
        </div>
      )}
    </section>
  );
}

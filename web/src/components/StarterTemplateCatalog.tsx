import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, UsersRound } from 'lucide-react';
import type { BotProfileDraft } from '../botProfiles';
import type { CreationStarter } from '../../../shared/creation-requests';
import { currentLanguage, uiText } from '../i18n';
import type { Language } from '../i18n/language';
import { starterBotPacks } from '../starterSkillPacks';
import {
  filterStarterTemplates,
  starterCategories,
  starterCategoryLabel,
  starterTemplates,
  type StarterCategory,
} from '../starterTemplates';
import { Avatar } from './Avatar';
import { BotTemplatePreview } from './BotTemplatePreview';
import './StarterTemplateCatalog.css';
export function StarterTemplateCatalog(props: {
  canCreate: boolean;
  disabled?: boolean;
  current: () => boolean;
  onChoose: (profile: BotProfileDraft, starter: CreationStarter) => void;
  onInstall?: (id: StarterCategory, language: Language) => void;
  installError?: string;
}) {
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState<StarterCategory | 'all'>('all'),
    [selected, setSelected] = useState<string>(),
    [page, setPage] = useState(0);
  const preview = useRef<HTMLElement>(null);
  useEffect(() => {
    const panel = preview.current;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 760px)').matches) panel.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latest = useRef(props);
  latest.current = props;
  const templates = starterTemplates(),
    visible = filterStarterTemplates(templates, query, category),
    item = templates.find((t) => t.id === selected);
  const language = currentLanguage();
  const pageSize = 4;
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const included = item ? starterBotPacks(item.id, language) : [];
  const live = () => mounted.current && latest.current.current() && !latest.current.disabled;
  return (
    <section className="starter-catalog" aria-label={uiText('workspace:starterTitle')}>
      {!props.onInstall && <p>{uiText('workspace:starterIntro')}</p>}
      <div className="starter-filters">
        <input
          type="search"
          value={query}
          aria-label={uiText('workspace:starterSearch')}
          placeholder={uiText('workspace:starterSearchHint')}
          onChange={(event) => {
            if (live()) {
              setQuery(event.target.value);
              setPage(0);
            }
          }}
        />
        <label>
          {uiText('workspace:starterCategory')}
          <select
            value={category}
            onChange={(event) => {
              if (live()) {
                setCategory(event.target.value as StarterCategory | 'all');
                setPage(0);
              }
            }}
          >
            {(['all', ...starterCategories] as const).map((value) => (
              <option key={value} value={value}>
                {starterCategoryLabel(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="starter-browser">
        <div className="starter-results">
          <div className="starter-grid">
            {shown.map((template) => (
              <button
                type="button"
                key={template.id}
                className={`starter-card${selected === template.id ? ' selected' : ''}`}
                aria-pressed={selected === template.id}
                disabled={props.disabled}
                onClick={() => {
                  if (live()) setSelected(template.id);
                }}
              >
                <Avatar agent={template.profile} size={44} />
                <span>
                  <strong>{template.profile.name}</strong>
                  <small>{starterCategoryLabel(template.category)}</small>
                  <p>{template.profile.description}</p>
                  {props.onInstall && (
                    <small>
                      {uiText('workspace:starterSkillCount', {
                        count: starterBotPacks(template.id, language).length,
                      })}
                    </small>
                  )}
                  <span className="starter-review-label">{uiText('workspace:starterReview')}</span>
                </span>
              </button>
            ))}
          </div>
          {!visible.length && <p role="status">{uiText('workspace:starterEmpty')}</p>}
          <nav className="starter-pagination" aria-label={uiText('workspace:starterPages')}>
            <button
              type="button"
              className="icon-button"
              aria-label={uiText('workspace:starterPrevious')}
              disabled={props.disabled || currentPage === 0}
              onClick={() => {
                if (live()) setPage(currentPage - 1);
              }}
            >
              <ChevronLeft size={16} />
            </button>
            <span aria-live="polite">
              {uiText('workspace:starterPage', { page: currentPage + 1, total: pageCount })}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={uiText('workspace:starterNext')}
              disabled={props.disabled || currentPage + 1 >= pageCount}
              onClick={() => {
                if (live()) setPage(currentPage + 1);
              }}
            >
              <ChevronRight size={16} />
            </button>
          </nav>
        </div>
        {item ? (
          <section
            ref={preview}
            tabIndex={-1}
            className="starter-selected"
            aria-label={uiText('workspace:starterReview')}
          >
            <div className="starter-selected-scroll">
              <BotTemplatePreview
                compact
                blueprint={{
                  version: 1,
                  profile: item.profile,
                  skills: included.map((pack) => ({
                    name: pack.name,
                    description: pack.description,
                    content: pack.instructions,
                  })),
                  routines: [],
                }}
              />
              {!!included.length && (
                <div
                  className="starter-skill-tags"
                  aria-label={uiText('workspace:starterSkillsLabel')}
                >
                  {included.map((pack) => (
                    <span key={pack.id}>{pack.name}</span>
                  ))}
                </div>
              )}
            </div>
            {props.canCreate ? (
              <div className="starter-selected-actions">
                {props.onInstall && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={props.disabled}
                    onClick={() => {
                      if (live() && latest.current.canCreate)
                        latest.current.onInstall?.(item.id, language);
                    }}
                  >
                    {uiText(
                      props.disabled ? 'workspace:starterInstalling' : 'workspace:starterInstall',
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className={props.onInstall ? 'secondary-button' : 'primary-button'}
                  disabled={props.disabled}
                  onClick={() => {
                    if (live() && latest.current.canCreate)
                      latest.current.onChoose(structuredClone(item.profile), {
                        id: item.id,
                        language,
                      });
                  }}
                >
                  {uiText('workspace:starterUse')}
                </button>
              </div>
            ) : (
              <p className="field-help">{uiText('workspace:starterOwner')}</p>
            )}
            {props.installError && (
              <p className="error-text" role="alert">
                {props.installError}
              </p>
            )}
          </section>
        ) : (
          <div className="starter-placeholder">
            <UsersRound size={36} aria-hidden="true" />
            <strong>{uiText('workspace:starterPickTitle')}</strong>
            <p>{uiText('workspace:starterPickHint')}</p>
          </div>
        )}
      </div>
      <p className="starter-notice">
        {uiText(props.onInstall ? 'workspace:starterInstallNotice' : 'workspace:starterNotice')}
      </p>
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { BotProfileDraft } from '../botProfiles';
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
  onChoose: (profile: BotProfileDraft) => void;
  onInstall?: (id: StarterCategory, language: Language) => void;
  installError?: string;
}) {
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState<StarterCategory | 'all'>('all'),
    [selected, setSelected] = useState<string>();
  const preview = useRef<HTMLElement>(null);
  useEffect(() => {
    preview.current?.focus({ preventScroll: true });
    preview.current?.scrollIntoView({ block: 'nearest' });
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
            if (live()) setQuery(event.target.value);
          }}
        />
        <label>
          {uiText('workspace:starterCategory')}
          <select
            value={category}
            onChange={(event) => {
              if (live()) setCategory(event.target.value as StarterCategory | 'all');
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
      <div className="starter-grid">
        {visible.map((template) => (
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
                  {uiText('workspace:starterIncludedSkills', {
                    names: starterBotPacks(template.id, language)
                      .map((pack) => pack.name)
                      .join(' · '),
                  })}
                </small>
              )}
              <span className="starter-review-label">{uiText('workspace:starterReview')}</span>
            </span>
          </button>
        ))}
      </div>
      {!visible.length && <p role="status">{uiText('workspace:starterEmpty')}</p>}
      {item && (
        <section
          ref={preview}
          tabIndex={-1}
          className="starter-selected"
          aria-label={uiText('workspace:starterReview')}
        >
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
                    latest.current.onChoose(structuredClone(item.profile));
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
          <BotTemplatePreview
            blueprint={{
              version: 1,
              profile: item.profile,
              skills: props.onInstall
                ? included.map((pack) => ({
                    name: pack.name,
                    description: pack.description,
                    content: pack.instructions,
                  }))
                : [],
              routines: [],
            }}
          />
        </section>
      )}
      <p className="starter-notice">
        {uiText(props.onInstall ? 'workspace:starterInstallNotice' : 'workspace:starterNotice')}
      </p>
    </section>
  );
}

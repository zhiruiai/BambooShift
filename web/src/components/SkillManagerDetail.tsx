import { ArrowLeft, Check, FileText, Folder, Pause, Sparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { Skill } from '../../../shared/types';
import { uiText } from '../i18n';
import { skillDisplayName, skillStatusLabel } from '../skillVersions';
import { Markdown } from './Markdown';
import { SkillPackageDetails } from './SkillPackageDetails';

export function SkillManagerDetail({
  skill,
  agentName,
  disabled,
  editable,
  focus,
  onReview,
  onBack,
}: {
  skill: Skill;
  agentName: string;
  disabled: boolean;
  editable: boolean;
  focus: boolean;
  onReview: () => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState('overview');
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const tabs = [
    { id: 'overview', label: uiText('settings:skillOverview'), icon: Sparkles },
    {
      id: 'instructions',
      label: skill.skillPackage ? 'SKILL.md' : uiText('settings:skillInstructions'),
      icon: FileText,
    },
    ...(skill.skillPackage
      ? [{ id: 'files', label: uiText('settings:skillFiles'), icon: Folder }]
      : []),
  ];
  useEffect(() => {
    if (focus) heading.current?.focus({ preventScroll: true });
  }, [focus]);
  return (
    <section className="skill-detail" aria-labelledby={`${id}-heading`}>
      <button type="button" className="text-button skill-detail-back" onClick={onBack}>
        <ArrowLeft size={15} />
        {uiText('settings:skillBackToList')}
      </button>
      <header className="skill-detail-heading">
        <div>
          <h3 ref={heading} tabIndex={-1} id={`${id}-heading`}>
            {skillDisplayName(skill)}
          </h3>
          <p>
            <span className={`pill ${skill.status === 'proposed' ? 'pending' : ''}`}>
              {skillStatusLabel(skill.status)}
            </span>
            <span>
              v{skill.version} · {agentName}
            </span>
          </p>
        </div>
        {editable && (
          <button
            type="button"
            className="secondary-button approve-skill"
            disabled={disabled}
            onClick={onReview}
          >
            {skill.status === 'active' ? <Pause size={14} /> : <Check size={14} />}
            {uiText(
              skill.status === 'proposed'
                ? 'common:text_f0979151f176'
                : skill.status === 'active'
                  ? 'common:text_e01cdce960fb'
                  : 'common:text_7fd2a0d1fe18',
            )}
          </button>
        )}
      </header>
      <div
        className="skill-detail-tabs"
        role="tablist"
        aria-label={uiText('settings:skillDetailTabs')}
        onKeyDown={(event) => {
          const index = tabs.findIndex((item) => item.id === tab);
          const positions: Record<string, number> = {
            Home: 0,
            End: tabs.length - 1,
            ArrowLeft: (index + tabs.length - 1) % tabs.length,
            ArrowRight: (index + 1) % tabs.length,
          };
          const next = positions[event.key];
          if (next === undefined) return;
          event.preventDefault();
          setTab(tabs[next].id);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {tabs.map(({ id: value, label, icon: Icon }) => (
          <button
            type="button"
            key={value}
            role="tab"
            id={`${id}-${value}`}
            aria-selected={tab === value}
            aria-controls={`${id}-content`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div
        className="skill-detail-body"
        key={tab}
        role="tabpanel"
        id={`${id}-content`}
        aria-labelledby={`${id}-${tab}`}
        tabIndex={0}
      >
        {tab === 'overview' && (
          <>
            <p className="skill-detail-description">{skill.description}</p>
            <dl className="skill-detail-facts">
              <div>
                <dt>{uiText('settings:skillFormat')}</dt>
                <dd>
                  {skill.skillPackage ? 'Agent Skills' : uiText('settings:skillInstructions')}
                </dd>
              </div>
              {skill.skillPackage && (
                <div>
                  <dt>{uiText('settings:skillFiles')}</dt>
                  <dd>{skill.skillPackage.files.length}</dd>
                </div>
              )}
            </dl>
            {skill.teamSource && (
              <p className="field-help">
                {uiText('common:teamSkillPinned', { value0: skill.teamSource.version })}
              </p>
            )}
            {(skill.status === 'disabled' || skill.status === 'archived') && (
              <p className="skill-history-note">
                {uiText(
                  skill.status === 'disabled'
                    ? 'common:text_043ee02fa5fe'
                    : 'common:text_db9139b1adec',
                )}
              </p>
            )}
          </>
        )}
        {tab === 'instructions' && <Markdown text={skill.content} />}
        {tab === 'files' && skill.skillPackage && (
          <SkillPackageDetails {...skill.skillPackage} skillId={skill.id} expandedFiles />
        )}
      </div>
    </section>
  );
}

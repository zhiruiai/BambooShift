import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Info, Loader2, Pause, RotateCcw } from 'lucide-react';
import type { Skill } from '../../../shared/types';
import { createFormSubmission, type FormSaveResult } from '../formSubmission';
import {
  skillAction,
  skillStatusLabel,
  skillTransitionLabel,
  type SkillAction,
} from '../skillVersions';
import { Markdown } from './Markdown';
import './SkillVersions.css';

export function SkillVersionReview({
  skill,
  current,
  busy,
  onBack,
  onApply,
}: {
  skill: Skill;
  current?: Skill;
  busy: boolean;
  onBack: () => void;
  onApply: (action: SkillAction, expectedActiveId: string | null) => Promise<FormSaveResult>;
}) {
  const [submission] = useState(createFormSubmission),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const feedback = useRef<HTMLDivElement>(null);
  const [reviewed] = useState(() => ({
    id: skill.id,
    status: skill.status,
    activeId: current?.id || null,
    action: skillAction(skill),
  }));
  const changed =
    reviewed.id !== skill.id ||
    reviewed.status !== skill.status ||
    reviewed.activeId !== (current?.id || null);
  const action = reviewed.action,
    locked = busy || pending;
  useEffect(() => {
    if (error) feedback.current?.focus();
  }, [error]);
  return (
    <section className="skill-version-review" aria-label={uiText('common:text_19858d9c4a7e')}>
      <button
        type="button"
        className="platform-text-button skill-review-back"
        disabled={locked}
        onClick={onBack}
      >
        <ArrowLeft size={15} />
        {uiText('common:text_572cf45ba436')}
      </button>
      <div className="skill-review-heading">
        <strong>
          {skill.name} · v{skill.version}
        </strong>
        <span
          className={`pill ${skill.status === 'proposed' ? 'pending' : skill.status === 'active' ? '' : 'skill-muted'}`}
        >
          {skillStatusLabel(skill.status)}
        </span>
      </div>
      <p className="section-help">
        {action === 'disable'
          ? uiText('common:text_199d174ee7a6')
          : current && current.id !== skill.id
            ? uiText('common:text_fbab2db75613', { value0: skill.version, value1: current.version })
            : uiText('common:text_cbface48f3ba')}
        {uiText('common:text_09068123f02b')}
      </p>
      <p>{skill.description}</p>
      <div className="skill-content skill-review-content">
        <Markdown text={skill.content} />
      </div>
      {current && current.id !== skill.id && (
        <details className="skill-version-compare">
          <summary>
            {uiText('common:text_c674ec733ef5')}
            {current.version}
          </summary>
          <div className="skill-content">
            <Markdown text={current.content} />
          </div>
        </details>
      )}
      {changed && (
        <div className="inline-save-error" role="alert">
          <Info size={15} />
          <span>{uiText('common:text_3ec168daa78f')}</span>
        </div>
      )}
      {error && (
        <div className="inline-save-error" role="alert" tabIndex={-1} ref={feedback}>
          <Info size={15} />
          <span>{error}</span>
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={locked} onClick={onBack}>
          {uiText('common:text_2cd0f3be8738')}
        </button>
        <button
          type="button"
          className={action === 'disable' ? 'secondary-button' : 'primary-button'}
          disabled={locked || changed}
          onClick={async () => {
            if (locked || changed || submission.pending) return;
            setPending(true);
            setError('');
            const result = await submission.submit(
              () => onApply(action, reviewed.activeId),
              onBack,
            );
            if (result && !result.ok) setError(result.error);
            setPending(false);
          }}
        >
          {pending ? (
            <Loader2 size={15} className="spin" />
          ) : action === 'disable' ? (
            <Pause size={15} />
          ) : action === 'restore' ? (
            <RotateCcw size={15} />
          ) : (
            <Check size={15} />
          )}
          {pending ? uiText('common:text_26ef00b7d061') : skillTransitionLabel(action)}
        </button>
      </div>
    </section>
  );
}

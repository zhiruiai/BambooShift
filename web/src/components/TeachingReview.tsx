import { useState } from 'react';
import type { ReviewTeaching, TeachingSession } from '../../../shared/teaching';
import { TEACHING_LIMITS } from '../../../shared/teaching';
import { uiText } from '../i18n';
import type { TeachingModel } from '../teaching';
export function teachingActionLabel(action: string) {
  const keys = {
    click: 'teachingClick',
    double_click: 'teachingDouble',
    right_click: 'teachingRight',
    drag: 'teachingDrag',
    scroll: 'teachingScroll',
    key: 'teachingKey',
    type: 'teachingType',
    navigate: 'teachingNavigate',
    back: 'teachingBack',
  } as const;
  return uiText(`workspace:${keys[action as keyof typeof keys] || 'teachingKey'}`);
}
export function TeachingReview({
  session,
  models,
  busy,
  onSave,
  onGenerate,
}: {
  session: TeachingSession;
  models: TeachingModel[];
  busy: boolean;
  onSave: (body: ReviewTeaching) => Promise<TeachingSession | undefined>;
  onGenerate: (profile: string, acceptPartial: boolean, fingerprint?: string) => Promise<boolean>;
}) {
  const [goal, setGoal] = useState(session.goal);
  const [steps, setSteps] = useState(() => session.steps.map(({ id, note }) => ({ id, note })));
  const [baseRevision, setBaseRevision] = useState(session.revision);
  const [savedDraft, setSavedDraft] = useState(JSON.stringify({ goal: session.goal, steps }));
  const [profile, setProfile] = useState(''),
    [partial, setPartial] = useState(false);
  const [profileFingerprint, setProfileFingerprint] = useState<string>();
  const profileChanged =
    !!profile && !models.some((m) => m.id === profile && m.fingerprint === profileFingerprint);
  const dirty = JSON.stringify({ goal, steps }) !== savedDraft;
  const changed = session.revision !== baseRevision;
  async function save() {
    const draft = { expectedRevision: baseRevision, goal, steps };
    const saved = await onSave(draft);
    if (saved) {
      setSavedDraft(JSON.stringify({ goal, steps }));
      setBaseRevision(saved.revision);
    }
  }
  function loadCurrent() {
    const selected = session.steps.map(({ id, note }) => ({ id, note }));
    setGoal(session.goal);
    setSteps(selected);
    setBaseRevision(session.revision);
    setSavedDraft(JSON.stringify({ goal: session.goal, steps: selected }));
  }
  return (
    <section className="teaching-review">
      {changed && (
        <div role="status">
          <p>{uiText('workspace:teachingChanged')}</p>
          <button className="secondary-button" disabled={busy} onClick={loadCurrent}>
            {uiText('workspace:teachingReload')}
          </button>
        </div>
      )}
      {session.interrupted && <div className="info-box">{uiText('workspace:teachingPartial')}</div>}
      <label>
        {uiText('workspace:teachingGoal')}
        <textarea
          value={goal}
          disabled={busy}
          maxLength={TEACHING_LIMITS.goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={2}
        />
      </label>
      <ol className="teaching-steps">
        {steps.map((step, index) => {
          const original = session.steps.find((s) => s.id === step.id);
          return (
            <li key={step.id}>
              <div>
                <strong>
                  {index + 1}. {teachingActionLabel(original?.action || '')}
                </strong>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setSteps((items) => items.filter((s) => s.id !== step.id))}
                >
                  {uiText('workspace:teachingRemove')}
                </button>
              </div>
              {original?.details && <small>{Object.values(original.details).join(' · ')}</small>}
              <label>
                <span className="visually-hidden">{uiText('workspace:teachingNote')}</span>
                <input
                  value={step.note}
                  disabled={busy}
                  maxLength={TEACHING_LIMITS.note}
                  placeholder={uiText('workspace:teachingNote')}
                  onChange={(event) =>
                    setSteps((items) =>
                      items.map((s) => (s.id === step.id ? { ...s, note: event.target.value } : s)),
                    )
                  }
                />
              </label>
            </li>
          );
        })}
      </ol>
      {!steps.length && <p>{uiText('workspace:teachingEmpty')}</p>}
      <button
        className="secondary-button"
        disabled={busy || !dirty || changed}
        onClick={() => void save()}
      >
        {uiText('workspace:teachingSave')}
      </button>
      {dirty && <p className="section-help">{uiText('workspace:teachingDirty')}</p>}
      <label>
        {uiText('workspace:teachingModel')}
        <select
          value={profile}
          disabled={busy}
          onChange={(event) => {
            setProfile(event.target.value);
            setProfileFingerprint(models.find((m) => m.id === event.target.value)?.fingerprint);
          }}
        >
          <option value="">{uiText('workspace:teachingSelectModel')}</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      {!models.length && <p>{uiText('workspace:teachingNoModel')}</p>}
      {profileChanged && <p role="status">{uiText('workspace:teachingModelChanged')}</p>}
      {session.interrupted && (
        <label className="teaching-confirm">
          <input
            type="checkbox"
            checked={partial}
            disabled={busy}
            onChange={(event) => setPartial(event.target.checked)}
          />
          {uiText('workspace:teachingAcceptPartial')}
        </label>
      )}
      <button
        className="primary-button"
        disabled={
          busy ||
          dirty ||
          changed ||
          !profile ||
          profileChanged ||
          !goal.trim() ||
          !steps.length ||
          (session.interrupted && !partial)
        }
        onClick={() => void onGenerate(profile, partial, profileFingerprint)}
      >
        {uiText('workspace:teachingGenerate')}
      </button>
    </section>
  );
}

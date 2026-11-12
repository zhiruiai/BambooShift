import { currentLanguage, uiText } from '../i18n';
import { Check, ChevronDown, Info, LibraryBig, Pause, Plus, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isSharedBot } from '../../../shared/shared-bots';
import type { BotAgent, Skill } from '../../../shared/types';
import { createFormSubmission, type FormSaveResult } from '../formSubmission';
import { skillWorkflowTemplates, type PackagedSkillDraft } from '../skillWorkflowTemplates';
import {
  currentSkillVersion,
  skillStatusLabel,
  skillVersionsInView,
  type SkillAction,
  type SkillView,
} from '../skillVersions';
import { Markdown } from './Markdown';
import { SkillVersionReview } from './SkillVersionReview';
import { SkillFileImport } from './SkillFileImport';
import { TeamSkillsView, type TeamSkillsAccess } from './TeamSkillsView';
import { Dialog } from './UI';

export function SkillsDialog({
  agents,
  skills,
  readOnly,
  busy,
  onClose,
  onAdd,
  onTransition,
  team,
  initialDraft,
}: {
  agents: BotAgent[];
  skills: Skill[];
  readOnly: boolean;
  busy: boolean;
  onClose: () => void;
  onAdd: (b: unknown) => Promise<FormSaveResult>;
  onTransition: (
    id: string,
    action: SkillAction,
    expectedActiveId: string | null,
  ) => Promise<FormSaveResult>;
  team?: TeamSkillsAccess;
  initialDraft?: PackagedSkillDraft;
}) {
  const editableAgents = agents.filter((agent) => !isSharedBot(agent));
  const workflowTemplates = skillWorkflowTemplates[currentLanguage()];
  const canEditSkill = (skill: Skill) =>
    !readOnly && editableAgents.some((agent) => agent.id === skill.agentId);
  const [adding, setAdding] = useState(!!initialDraft),
    [agentId, setAgentId] = useState(initialDraft?.agentId || editableAgents[0]?.id || ''),
    [name, setName] = useState(initialDraft?.recipe.name || ''),
    [description, setDescription] = useState(initialDraft?.recipe.description || ''),
    [content, setContent] = useState(initialDraft?.recipe.content || ''),
    [expanded, setExpanded] = useState('');
  const [view, setView] = useState<SkillView>(() =>
    skills.some((s) => s.status === 'proposed') ? 'proposals' : 'current',
  );
  const [reviewId, setReviewId] = useState('');
  const [showTeam, setShowTeam] = useState(false);
  const reviewing = skills.find((s) => s.id === reviewId);
  const [submission] = useState(createFormSubmission);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const draftForm = useRef<HTMLFormElement>(null);
  const draftBot = useRef<HTMLSelectElement>(null);
  const locked = busy || saving;
  useEffect(() => {
    if (!adding) return;
    draftForm.current?.scrollIntoView({ block: 'start' });
    draftBot.current?.focus({ preventScroll: true });
  }, [adding, initialDraft]);
  useEffect(() => {
    if (saveError) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [saveError]);
  async function save() {
    if (
      readOnly ||
      !editableAgents.some((agent) => agent.id === agentId) ||
      busy ||
      submission.pending ||
      !name.trim() ||
      !description.trim() ||
      !content.trim()
    )
      return;
    setSaving(true);
    setSaveError('');
    const result = await submission.submit(
      () => onAdd({ agentId, name, description, content }),
      () => {
        setAdding(false);
        setName('');
        setDescription('');
        setContent('');
        setView('proposals');
      },
    );
    if (result && !result.ok) setSaveError(result.error);
    setSaving(false);
  }
  return (
    <Dialog
      title={uiText('common:text_2c38f222bfa4')}
      subtitle={uiText('common:text_d6a77a2071ee')}
      onClose={() => {
        if (!locked && !submission.pending) onClose();
      }}
    >
      {showTeam && team ? (
        <TeamSkillsView
          access={{
            ...team,
            onImported: (agentId) => {
              team.onImported(agentId);
              setAgentId(agentId);
              setReviewId('');
              setView('proposals');
              setShowTeam(false);
            },
          }}
          skills={skills}
          readOnly={readOnly}
          onBack={() => setShowTeam(false)}
        />
      ) : reviewId && !readOnly && (!reviewing || canEditSkill(reviewing)) ? (
        reviewing ? (
          <SkillVersionReview
            key={reviewId}
            skill={reviewing}
            current={currentSkillVersion(skills, reviewing)}
            busy={busy}
            onBack={() => setReviewId('')}
            onApply={(transition, expectedActiveId) =>
              onTransition(reviewing.id, transition, expectedActiveId)
            }
          />
        ) : (
          <>
            <p className="section-help">{uiText('common:text_e03f7ae636da')}</p>
            <button className="secondary-button" onClick={() => setReviewId('')}>
              {uiText('common:text_f96743fda8d2')}
            </button>
          </>
        )
      ) : (
        <>
          <div className="info-box">
            <Sparkles size={16} />
            <span>
              {readOnly || !editableAgents.length
                ? uiText('common:text_59294c3c8bdf')
                : uiText('common:text_23d225f28f98')}
            </span>
          </div>
          {team && !adding && (
            <button
              className="secondary-button team-skill-entry"
              type="button"
              disabled={locked}
              onClick={() => setShowTeam(true)}
            >
              <LibraryBig size={15} aria-hidden="true" />
              {uiText('common:teamSkillTitle')}
            </button>
          )}
          <div
            className="skill-version-tabs"
            role="group"
            aria-label={uiText('common:text_1d724da1aa0c')}
          >
            {(
              [
                ['current', uiText('common:text_5ddff4afab27')],
                ['proposals', uiText('common:text_a8b0bd9c65f7')],
                ['history', uiText('common:text_6fd29579ab66')],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={view === id}
                disabled={locked}
                onClick={() => setView(id)}
              >
                {label}
                <small>{skillVersionsInView(skills, id).length}</small>
              </button>
            ))}
          </div>
          <div className="skill-list">
            {skillVersionsInView(skills, view).map((s) => (
              <div className="skill-card" key={s.id}>
                <button
                  className="skill-heading"
                  aria-expanded={expanded === s.id}
                  onClick={() => setExpanded(expanded === s.id ? '' : s.id)}
                >
                  <span className="resource-icon lavender">
                    <Sparkles size={17} />
                  </span>
                  <span>
                    <strong>{s.name}</strong>
                    <small>
                      v{s.version} ·{' '}
                      {agents.find((a) => a.id === s.agentId)?.name ||
                        uiText('common:text_25536a7889ed')}
                    </small>
                  </span>
                  <span
                    className={`pill ${s.status === 'proposed' ? 'pending' : s.status === 'active' ? '' : 'skill-muted'}`}
                  >
                    {skillStatusLabel(s.status)}
                  </span>
                  <ChevronDown size={14} />
                </button>
                <p>{s.description}</p>
                {s.teamSource && (
                  <p className="field-help">
                    {uiText('common:teamSkillPinned', { value0: s.teamSource.version })}
                  </p>
                )}
                {(s.status === 'archived' || s.status === 'disabled') && (
                  <small className="skill-history-note">
                    {s.status === 'disabled'
                      ? uiText('common:text_043ee02fa5fe')
                      : uiText('common:text_db9139b1adec')}
                  </small>
                )}
                {expanded === s.id && (
                  <div className="skill-content">
                    <Markdown text={s.content} />
                  </div>
                )}
                {canEditSkill(s) && (
                  <button
                    className="secondary-button approve-skill"
                    disabled={locked}
                    onClick={() => {
                      setReviewId(s.id);
                      setSaveError('');
                    }}
                  >
                    {s.status === 'active' ? <Pause size={14} /> : <Check size={14} />}
                    {s.status === 'proposed'
                      ? uiText('common:text_f0979151f176')
                      : s.status === 'active'
                        ? uiText('common:text_e01cdce960fb')
                        : uiText('common:text_7fd2a0d1fe18')}
                  </button>
                )}
              </div>
            ))}
          </div>
          {skillVersionsInView(skills, view).length === 0 && (
            <p className="section-help">
              {view === 'current'
                ? uiText('common:text_6c1973ebd192')
                : view === 'proposals'
                  ? uiText('common:text_75ad326d6613')
                  : uiText('common:text_f2ae7b5e827e')}
            </p>
          )}
          {!readOnly &&
            editableAgents.length > 0 &&
            (adding ? (
              <form
                ref={draftForm}
                className="dialog-form bordered-form"
                aria-busy={saving}
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <h3>{uiText('common:text_f4b0fa7e6b83')}</h3>
                <label>
                  {uiText('common:text_68458e102038')}
                  <select
                    ref={draftBot}
                    disabled={locked}
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                  >
                    {editableAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {uiText('common:skill_workflow_template')}
                  <select
                    disabled={locked}
                    value=""
                    onChange={(event) => {
                      const template = workflowTemplates.find(
                        ({ id }) => id === event.target.value,
                      );
                      if (!template) return;
                      setName(template.name);
                      setDescription(template.description);
                      setContent(template.content);
                      setSaveError('');
                    }}
                  >
                    <option value="" disabled>
                      {uiText('common:skill_workflow_template_placeholder')}
                    </option>
                    {workflowTemplates.map(({ id, name }) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {uiText('common:text_939f41f5c276')}
                  <input
                    disabled={locked}
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  {uiText('common:text_3e7120a81b35')}
                  <input
                    required
                    disabled={locked}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <label>
                  {uiText('common:text_94d9aed12735')}
                  <textarea
                    required
                    rows={4}
                    disabled={locked}
                    aria-describedby={saveError ? 'skill-create-error' : undefined}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={uiText('common:text_74fde5186d5b')}
                  />
                </label>
                {saveError && (
                  <div
                    className="inline-save-error"
                    id="skill-create-error"
                    role="alert"
                    tabIndex={-1}
                    ref={errorRef}
                  >
                    <Info size={15} />
                    <span>
                      {saveError}
                      {uiText('common:text_94df5264df0b')}
                    </span>
                  </div>
                )}
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      setAdding(false);
                      setSaveError('');
                    }}
                  >
                    {uiText('common:text_2cd0f3be8738')}
                  </button>
                  <button
                    className="primary-button"
                    disabled={locked || !name.trim() || !description.trim() || !content.trim()}
                  >
                    {saving
                      ? uiText('common:text_6bdb4435095e')
                      : uiText('common:text_d81e84e915a0')}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <button
                  className="add-detail-row"
                  disabled={locked}
                  onClick={() => setAdding(true)}
                >
                  <Plus size={17} />
                  {uiText('common:text_71b3a207d7fe')}
                </button>
                <SkillFileImport
                  disabled={locked}
                  onImport={(draft) => {
                    setName(draft.name);
                    setDescription(draft.description);
                    setContent(draft.content);
                    setSaveError('');
                    setAdding(true);
                  }}
                />
              </>
            ))}
        </>
      )}
    </Dialog>
  );
}

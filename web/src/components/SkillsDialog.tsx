import { uiText } from '../i18n';
import { Info, LibraryBig, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isSharedBot } from '../../../shared/shared-bots';
import type { BotAgent, Skill } from '../../../shared/types';
import { createFormSubmission, type FormSaveResult } from '../formSubmission';
import type { ImportedSkillDraft } from '../skillFileImport';
import { skillPackageUpload, type SkillPackageDraft } from '../skillPackageImport';
import type { PackagedSkillDraft } from '../skillWorkflowTemplates';
import type { InstallSkill } from '../skillInstallation';
import type { ImportedSkillPackage } from '../skillPackageImport';
import { SkillInstallation } from './SkillInstallation';
import { currentSkillVersion, type SkillAction, type SkillView } from '../skillVersions';
import { SkillManager } from './SkillManager';
import { SkillVersionReview } from './SkillVersionReview';
import { SkillFileImport } from './SkillFileImport';
import { SkillPackageDetails } from './SkillPackageDetails';
import { SkillPackageImport, skillPackageErrorText } from './SkillPackageImport';
import { TeamSkillsView, type TeamSkillsAccess } from './TeamSkillsView';
import { Dialog } from './UI';
import { PackagedSkillsCatalog } from './apps/PackagedSkillsCatalog';

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
  onInstall,
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
  onInstall?: InstallSkill;
}) {
  const editableAgents = agents.filter((agent) => !isSharedBot(agent));
  const canEditSkill = (skill: Skill) =>
    !readOnly && editableAgents.some((agent) => agent.id === skill.agentId);
  const [adding, setAdding] = useState(!!initialDraft),
    [agentId, setAgentId] = useState(initialDraft?.agentId || editableAgents[0]?.id || ''),
    [name, setName] = useState(initialDraft?.skill.name || ''),
    [description, setDescription] = useState(initialDraft?.skill.description || ''),
    [content, setContent] = useState(initialDraft?.skill.content || '');
  const [view, setView] = useState<SkillView>('current');
  const [reviewId, setReviewId] = useState('');
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [packageDraft, setPackageDraft] = useState(initialDraft?.skill.skillPackage);
  const [showTeam, setShowTeam] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [importing, setImporting] = useState<ImportedSkillPackage>();
  const reviewing = skills.find((s) => s.id === reviewId);
  const [submission] = useState(createFormSubmission);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const draftForm = useRef<HTMLFormElement>(null);
  const draftBot = useRef<HTMLSelectElement>(null);
  const catalogButton = useRef<HTMLButtonElement>(null);
  const returningFromCatalog = useRef(false);
  const locked = busy || saving;
  const managing = !adding && !showCatalog && !importing && !showTeam && !reviewId;
  const canSave = !!name.trim() && !!description.trim() && (!!packageDraft || !!content.trim());
  function showInstalledSkill(installedId: string) {
    setSelectedSkillId(installedId);
    setView('current');
    setImporting(undefined);
    setShowCatalog(false);
  }
  function fillDraft(draft: ImportedSkillDraft, skillPackage?: SkillPackageDraft) {
    setName(draft.name);
    setDescription(draft.description);
    setContent(draft.content);
    setPackageDraft(skillPackage);
    setSaveError('');
    setAdding(true);
  }
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
  useEffect(() => {
    if (!showCatalog && returningFromCatalog.current) {
      returningFromCatalog.current = false;
      catalogButton.current?.focus({ preventScroll: true });
    }
  }, [showCatalog]);
  async function save() {
    if (
      readOnly ||
      !editableAgents.some((agent) => agent.id === agentId) ||
      busy ||
      submission.pending ||
      !canSave
    )
      return;
    const draft = { agentId, name, description, content };
    let skillPackage: ReturnType<typeof skillPackageUpload> | undefined;
    try {
      if (packageDraft) skillPackage = skillPackageUpload(draft, packageDraft);
    } catch (error) {
      setSaveError(skillPackageErrorText(error));
      return;
    }
    setSaving(true);
    setSaveError('');
    const result = await submission.submit(
      () => onAdd(skillPackage ? { ...draft, skillPackage } : draft),
      () => {
        setAdding(false);
        setName('');
        setDescription('');
        setContent('');
        setPackageDraft(undefined);
        setView('proposals');
      },
    );
    if (result && !result.ok) setSaveError(result.error);
    setSaving(false);
  }
  return (
    <Dialog
      className={`bot-skills-dialog${managing ? ' skill-manager-dialog' : ''}`}
      title={uiText(showCatalog ? 'workspace:packagedSkillsTitle' : 'common:text_2c38f222bfa4')}
      subtitle={
        agents.length === 1
          ? uiText('settings:botSkillsScope', { name: agents[0].name })
          : uiText('common:text_d6a77a2071ee')
      }
      onClose={() => {
        if (!locked && !submission.pending) onClose();
      }}
    >
      {showCatalog ? (
        <PackagedSkillsCatalog
          embedded
          bots={editableAgents}
          skills={skills}
          initialAgentId={editableAgents.length === 1 ? editableAgents[0].id : agentId}
          canEdit={!readOnly}
          disabled={locked}
          onExit={() => {
            returningFromCatalog.current = true;
            setShowCatalog(false);
          }}
          onInstall={onInstall}
          onBusyChange={setSaving}
          onInstalled={showInstalledSkill}
        />
      ) : importing ? (
        <section className="packaged-skill-preview">
          <button
            type="button"
            className="text-button"
            disabled={locked}
            onClick={() => setImporting(undefined)}
          >
            {uiText('settings:botSkillsCatalogBack')}
          </button>
          <header className="packaged-skill-heading">
            <div>
              <h3>{importing.skillPackage.frontmatter.metadata?.title || importing.name}</h3>
              <p>{importing.description}</p>
            </div>
          </header>
          <SkillInstallation
            skill={importing}
            bots={editableAgents}
            skills={skills}
            initialAgentId={agentId}
            disabled={locked}
            canEdit={!readOnly}
            onInstall={onInstall}
            onBusyChange={setSaving}
            onDone={showInstalledSkill}
          />
        </section>
      ) : showTeam && team ? (
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
            onApply={async (transition, expectedActiveId) => {
              const result = await onTransition(reviewing.id, transition, expectedActiveId);
              if (result.ok) {
                setView(transition === 'disable' ? 'history' : 'current');
                setSelectedSkillId(reviewing.id);
              }
              return result;
            }}
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
          {!adding && (
            <>
              {!readOnly && editableAgents.length > 0 && (
                <div className="skill-add-actions">
                  <button
                    ref={catalogButton}
                    className="primary-button"
                    type="button"
                    disabled={locked}
                    onClick={() => setShowCatalog(true)}
                  >
                    <LibraryBig size={16} aria-hidden="true" />
                    {uiText('settings:botSkillsCatalog')}
                  </button>
                  <SkillPackageImport
                    disabled={locked}
                    onImport={(draft) =>
                      onInstall ? setImporting(draft) : fillDraft(draft, draft.skillPackage)
                    }
                  />
                </div>
              )}
              {(readOnly || !editableAgents.length) && (
                <p className="section-help">{uiText('common:text_59294c3c8bdf')}</p>
              )}
              <SkillManager
                skills={skills}
                agents={agents}
                view={view}
                disabled={locked}
                onView={setView}
                canEdit={canEditSkill}
                initialSelection={selectedSkillId}
                compact={!!team}
                onReview={(id) => {
                  setSelectedSkillId(id);
                  setReviewId(id);
                  setSaveError('');
                }}
              />
              {team && (
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
            </>
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
                <h3>{uiText('settings:botSkillsPackageDraft')}</h3>
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
                  {uiText('common:text_939f41f5c276')}
                  <input
                    disabled={locked}
                    readOnly={!!packageDraft}
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  {uiText('common:text_3e7120a81b35')}
                  <textarea
                    required
                    rows={2}
                    disabled={locked}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <label>
                  {uiText('common:text_94d9aed12735')}
                  <textarea
                    required={!packageDraft}
                    rows={4}
                    disabled={locked}
                    aria-describedby={saveError ? 'skill-create-error' : undefined}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={uiText('common:text_74fde5186d5b')}
                  />
                </label>
                {packageDraft && (
                  <SkillPackageDetails
                    {...packageDraft}
                    files={[{ path: 'SKILL.md' }, ...packageDraft.files]}
                  />
                )}
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
                  <button className="primary-button" disabled={locked || !canSave}>
                    {saving
                      ? uiText('common:text_6bdb4435095e')
                      : uiText('common:text_d81e84e915a0')}
                  </button>
                </div>
              </form>
            ) : (
              <div className="skill-secondary-actions">
                <button
                  className="add-detail-row"
                  disabled={locked}
                  onClick={() => {
                    if (packageDraft) fillDraft({ name: '', description: '', content: '' });
                    else setAdding(true);
                  }}
                >
                  <Plus size={17} />
                  {uiText('settings:botSkillsNewPackage')}
                </button>
                <SkillFileImport disabled={locked} onImport={fillDraft} />
              </div>
            ))}
        </>
      )}
    </Dialog>
  );
}

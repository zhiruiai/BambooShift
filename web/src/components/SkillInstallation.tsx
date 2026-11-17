import { CheckCircle2, FileCode2, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BotAgent, Skill } from '../../../shared/types';
import { uiText } from '../i18n';
import {
  matchesSkillPackage,
  reconcileSkillReceipt,
  type InstallSkill,
} from '../skillInstallation';
import type { ImportedSkillPackage } from '../skillPackageImport';
import { Markdown } from './Markdown';
import { SkillPackageDetails } from './SkillPackageDetails';

export function SkillInstallation({
  skill,
  bots,
  skills,
  initialAgentId,
  disabled,
  canEdit,
  onInstall,
  onBusyChange,
  onDone,
  fileContents,
}: {
  skill: ImportedSkillPackage;
  bots: readonly Pick<BotAgent, 'id' | 'name'>[];
  skills: readonly Skill[];
  initialAgentId?: string;
  disabled: boolean;
  canEdit: boolean;
  onInstall?: InstallSkill;
  onBusyChange?: (busy: boolean) => void;
  onDone: (installedId: string) => void;
  fileContents?: Readonly<Record<string, string>>;
}) {
  const [target, setTarget] = useState(initialAgentId || (bots.length === 1 ? bots[0].id : ''));
  const [receipt, setReceipt] = useState<Skill>();
  const acknowledgedReceipt = useRef('');
  const [checking, setChecking] = useState(true);
  const [identical, setIdentical] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const status = useRef<HTMLDivElement>(null);
  const selectedBot = bots.find(({ id }) => id === target);
  const reconciled =
    receipt?.agentId === target
      ? reconcileSkillReceipt(skills, receipt, acknowledgedReceipt.current === receipt.id)
      : undefined;
  const active = reconciled
    ? reconciled.active
    : skills.find(
        (item) => item.agentId === target && item.status === 'active' && item.name === skill.name,
      );
  const showReceipt = !!receipt && active?.id === receipt.id;
  useEffect(() => {
    if (receipt && reconciled?.acknowledged) acknowledgedReceipt.current = receipt.id;
  }, [receipt, reconciled?.acknowledged]);
  useEffect(() => {
    let current = true;
    setChecking(true);
    setIdentical(false);
    void (active ? matchesSkillPackage(active, skill) : Promise.resolve(false))
      .then((value) => {
        if (current) {
          setIdentical(value);
          setChecking(false);
        }
      })
      .catch(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [active, skill]);
  useEffect(() => {
    if (receipt || error) {
      status.current?.focus({ preventScroll: true });
      status.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [receipt, error]);
  const locked = disabled || saving;
  async function install() {
    if (
      !onInstall ||
      !selectedBot ||
      !canEdit ||
      locked ||
      pending.current ||
      checking ||
      identical
    )
      return;
    pending.current = true;
    setSaving(true);
    setError('');
    onBusyChange?.(true);
    try {
      const confirmed = await onInstall({ agentId: selectedBot.id, skill }, active?.id || null);
      setReceipt(confirmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiText('common:text_072387ead00b'));
    } finally {
      pending.current = false;
      setSaving(false);
      onBusyChange?.(false);
    }
  }
  return (
    <>
      <div className="skill-install-summary">
        <FileCode2 size={16} aria-hidden="true" />
        <span>
          {uiText('workspace:packagedSkillsFiles', { count: skill.skillPackage.files.length + 1 })}
        </span>
        <span>{uiText('workspace:packagedSkillsReady')}</span>
      </div>
      {canEdit ? (
        bots.length ? (
          <div className="packaged-skill-install" aria-busy={saving}>
            {bots.length === 1 ? (
              <strong>{uiText('workspace:packagedSkillsTarget', { bot: bots[0].name })}</strong>
            ) : (
              <label>
                <span>{uiText('workspace:packagedSkillsChooseBot')}</span>
                <select
                  value={target}
                  disabled={locked}
                  onChange={(event) => {
                    setTarget(event.target.value);
                    setError('');
                    setReceipt(undefined);
                  }}
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
            )}
            <button
              type="button"
              className="primary-button"
              disabled={locked || checking || identical || !selectedBot || !onInstall}
              onClick={() => void install()}
            >
              {saving && <Loader2 size={15} className="spin" aria-hidden="true" />}
              {identical && <CheckCircle2 size={15} aria-hidden="true" />}
              {uiText(
                saving
                  ? 'workspace:packagedSkillsInstalling'
                  : identical
                    ? 'workspace:packagedSkillsInstalled'
                    : active
                      ? 'workspace:packagedSkillsUpdate'
                      : 'workspace:packagedSkillsInstall',
              )}
            </button>
            <p>
              {uiText(
                active && !identical
                  ? 'workspace:packagedSkillsReplace'
                  : 'workspace:packagedSkillsApproval',
              )}
            </p>
            {(showReceipt || error) && (
              <div
                ref={status}
                tabIndex={-1}
                role={error ? 'alert' : 'status'}
                className={
                  error
                    ? 'error-text skill-install-feedback'
                    : 'skill-install-success skill-install-feedback'
                }
              >
                {error || (
                  <>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <span>
                      {uiText('workspace:packagedSkillsSuccess', { bot: selectedBot?.name })}
                    </span>
                  </>
                )}
              </div>
            )}
            {showReceipt && !error && (
              <button
                type="button"
                className="secondary-button skill-install-done"
                disabled={locked}
                onClick={() => onDone(receipt.id)}
              >
                {uiText('workspace:packagedSkillsDone')}
              </button>
            )}
          </div>
        ) : (
          <p className="field-help">{uiText('workspace:packagedSkillsNoBots')}</p>
        )
      ) : (
        <p className="field-help">{uiText('workspace:packagedSkillsReadOnly')}</p>
      )}
      <details className="skill-install-details">
        <summary>{uiText('workspace:packagedSkillsDetails')}</summary>
        <div className="packaged-skill-document">
          <SkillPackageDetails
            {...skill.skillPackage}
            files={[{ path: 'SKILL.md' }, ...skill.skillPackage.files]}
            fileContents={fileContents}
            expandedFiles
          />
          <section className="packaged-skill-instructions">
            <h4>{uiText('workspace:packagedSkillsInstructions')}</h4>
            <div className="skill-content packaged-skill-content">
              <Markdown text={skill.content} passive />
            </div>
          </section>
        </div>
      </details>
    </>
  );
}

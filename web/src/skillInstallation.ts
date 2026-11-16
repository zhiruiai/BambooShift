import type { Skill } from '../../shared/types';
import type { ImportedSkillPackage } from './skillPackageImport';
import { skillPackageUpload } from './skillPackageImport';
import type { PackagedSkillDraft } from './skillWorkflowTemplates';

export type InstallSkill = (
  draft: PackagedSkillDraft,
  expectedActiveId: string | null,
) => Promise<Skill>;

/** A confirmed response bridges refresh latency only until the server list observes it. */
export function reconcileSkillReceipt(
  skills: readonly Skill[],
  receipt: Skill,
  acknowledged: boolean,
) {
  const current = skills.find(
    (item) =>
      item.agentId === receipt.agentId && item.name === receipt.name && item.status === 'active',
  );
  const observed = skills.find((item) => item.id === receipt.id);
  const synced =
    acknowledged ||
    !!(observed && observed.status !== 'proposed') ||
    !!(current && current.version > receipt.version);
  return { acknowledged: synced, active: synced ? current : receipt };
}

export function acceptInstalledSkill(skills: Skill[], installed: Skill): Skill[] {
  return [
    ...skills
      .filter((skill) => skill.id !== installed.id)
      .map((skill) =>
        skill.agentId === installed.agentId &&
        skill.name === installed.name &&
        skill.status === 'active'
          ? { ...skill, status: 'archived' as const }
          : skill,
      ),
    installed,
  ];
}

export function skillInstallBody(
  { agentId, skill }: PackagedSkillDraft,
  expectedActiveId: string | null,
) {
  return {
    agentId,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    skillPackage: skillPackageUpload(skill, skill.skillPackage),
    expectedActiveId,
  };
}

function canonical(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      ),
    );
  return JSON.stringify(value);
}

export async function matchesSkillPackage(skill: Skill, draft: ImportedSkillPackage) {
  const manifest = skill.skillPackage;
  if (
    !manifest ||
    skill.name !== draft.name ||
    skill.description !== draft.description ||
    skill.content !== draft.content ||
    manifest.root !== draft.skillPackage.root
  )
    return false;
  const { name: _name, description: _description, ...extra } = manifest.frontmatter;
  const desired = { ...draft.skillPackage.frontmatter };
  if (desired.metadata && !Object.keys(desired.metadata).length) delete desired.metadata;
  if (canonical(extra) !== canonical(desired)) return false;
  const resources = manifest.files.filter(({ path }) => path !== 'SKILL.md');
  if (resources.length !== draft.skillPackage.files.length) return false;
  return (
    await Promise.all(
      draft.skillPackage.files.map(async (file) => {
        const existing = resources.find(({ path }) => path === file.path);
        if (!existing || existing.size !== file.size) return false;
        const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return (
          existing.sha256 ===
          Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
        );
      }),
    )
  ).every(Boolean);
}

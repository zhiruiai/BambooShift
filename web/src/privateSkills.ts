export type PrivateSkillAgent = { id: string; name: string };
export type PrivateSkill = {
  id: string;
  sourceAgentId: string;
  sourceAgentName: string;
  name: string;
  description: string;
  content: string;
  version: number;
  revision: string;
  available: boolean;
  enabledAgentIds: string[];
};
export type PrivateSkillShelf = { agents: PrivateSkillAgent[]; skills: PrivateSkill[] };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

export const privateSkillKey = (skill: Pick<PrivateSkill, 'id' | 'revision'>) =>
  `${skill.id}:${skill.revision}`;

export function parsePrivateSkillShelf(value: unknown): PrivateSkillShelf | undefined {
  if (!record(value) || !Array.isArray(value.agents) || !Array.isArray(value.skills)) return;
  const agents: PrivateSkillAgent[] = [];
  const skills: PrivateSkill[] = [];
  const agentIds = new Set<string>();
  const skillIds = new Set<string>();
  for (const agent of value.agents) {
    if (!record(agent) || !identifier(agent.id) || agentIds.has(agent.id) || !label(agent.name))
      return;
    agents.push({ id: agent.id, name: agent.name });
    agentIds.add(agent.id);
  }
  for (const skill of value.skills) {
    if (!record(skill)) return;
    const {
      id,
      sourceAgentId,
      sourceAgentName,
      name,
      description,
      content,
      version,
      revision,
      available,
      enabledAgentIds,
    } = skill;
    if (
      !identifier(id) ||
      !identifier(sourceAgentId) ||
      !label(sourceAgentName) ||
      !label(name) ||
      typeof description !== 'string' ||
      typeof content !== 'string' ||
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(revision) ||
      typeof available !== 'boolean' ||
      !Array.isArray(enabledAgentIds) ||
      !enabledAgentIds.every(identifier) ||
      new Set(enabledAgentIds).size !== enabledAgentIds.length
    )
      return;
    const key = privateSkillKey({ id, revision });
    if (skillIds.has(key)) return;
    skillIds.add(key);
    skills.push({
      id,
      sourceAgentId,
      sourceAgentName,
      name,
      description,
      content,
      version,
      revision,
      available,
      enabledAgentIds,
    });
  }
  return { agents, skills };
}

export function privateSkillTargets(shelf: PrivateSkillShelf, skill: PrivateSkill) {
  return shelf.agents.filter(
    (agent) =>
      agent.id !== skill.sourceAgentId &&
      (skill.available || skill.enabledAgentIds.includes(agent.id)),
  );
}

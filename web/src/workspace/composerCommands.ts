import type { BotAgent, Skill } from '../../../shared/types';
import { isSharedBot } from '../../../shared/shared-bots';
import { uiText } from '../i18n';

export type ComposerCommand = {
  id: string;
  kind: 'skill' | 'settings' | 'computer' | 'routines' | 'apps';
  title: string;
  description: string;
  keywords: string;
  agentId?: string;
  skillName?: string;
  skillId?: string;
};
export type CommandToken = { start: number; end: number; value: string; query: string };

export function commandToken(text: string, start: number, end = start): CommandToken | undefined {
  if (start !== end || start < 0 || start > text.length) return;
  const before = text.slice(0, start).match(/(?:^|\s)\/([^\s/]*)$/u);
  if (!before) return;
  const offset = start - before[1].length - 1;
  const after = text.slice(start).match(/^[^\s]*/u)![0];
  if (after.includes('/')) return;
  const finish = start + after.length;
  return {
    start: offset,
    end: finish,
    value: text.slice(offset, finish),
    query: text.slice(offset + 1, finish),
  };
}

export function mentionToken(text: string, start: number, end = start): CommandToken | undefined {
  if (start !== end || start < 0 || start > text.length) return;
  const before = text
    .slice(0, start)
    .match(/(?<![\p{Script=Latin}\p{N}._%+/@-])@([^\s@，。！？、：；!?;:,()[\]{}]*)$/u);
  if (!before) return;
  const offset = start - before[1].length - 1;
  const after = text.slice(start).match(/^[^\s@，。！？、：；!?;:,()[\]{}]*/u)![0];
  const finish = start + after.length;
  return {
    start: offset,
    end: finish,
    value: text.slice(offset, finish),
    query: text.slice(offset + 1, finish),
  };
}

export function replaceCommand(text: string, token: CommandToken, insertion = '') {
  if (text.slice(token.start, token.end) !== token.value) return;
  return {
    text: text.slice(0, token.start) + insertion + text.slice(token.end),
    caret: token.start + insertion.length,
  };
}

export function composerCommands({
  skills,
  members,
  canManage,
  agentId,
  skillsEnabled = true,
}: {
  skills: Skill[];
  members: BotAgent[];
  canManage: boolean;
  agentId?: string;
  skillsEnabled?: boolean;
}): ComposerCommand[] {
  const commands: ComposerCommand[] = [];
  if (skillsEnabled) {
    for (const skill of skills) {
      const agent = members.find((item) => item.id === skill.agentId);
      if (
        skill.status !== 'active' ||
        !agent ||
        (agentId && agent.id !== agentId) ||
        (isSharedBot(agent) && agent.sharedBot?.status !== 'active')
      )
        continue;
      commands.push({
        id: `skill:${skill.id}`,
        kind: 'skill',
        title: skill.name,
        description: uiText('workspace:composerSkillOwner', { name: agent.name }),
        keywords: `${skill.name} ${skill.description} ${agent.name}`,
        agentId: agent.id,
        skillName: skill.name,
        ...(!isSharedBot(agent) ? { skillId: skill.id } : {}),
      });
    }
  }
  commands.push(
    {
      id: 'settings',
      kind: 'settings',
      title: uiText('workspace:composerSettings'),
      description: uiText('workspace:composerSettingsHint'),
      keywords: uiText('workspace:composerSettingsKeywords'),
    },
    {
      id: 'computer',
      kind: 'computer',
      title: uiText('workspace:composerComputer'),
      description: uiText('workspace:composerComputerHint'),
      keywords: uiText('workspace:composerComputerKeywords'),
    },
    {
      id: 'apps',
      kind: 'apps',
      title: uiText('workspace:composerApps'),
      description: uiText('workspace:composerAppsHint'),
      keywords: uiText('workspace:composerAppsKeywords'),
    },
  );
  if (canManage)
    commands.push({
      id: 'routines',
      kind: 'routines',
      title: uiText('workspace:composerRoutines'),
      description: uiText('workspace:composerRoutinesHint'),
      keywords: uiText('workspace:composerRoutinesKeywords'),
    });
  return commands;
}

export function matchingCommands(commands: ComposerCommand[], query: string) {
  const normalized = query.toLocaleLowerCase();
  return commands.filter((item) =>
    `${item.title} ${item.keywords}`.toLocaleLowerCase().includes(normalized),
  );
}

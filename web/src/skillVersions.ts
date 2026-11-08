import { currentLanguage } from './i18n';
import { uiText } from './i18n';
import type { Skill } from '../../shared/types';

export type SkillAction = 'approve' | 'restore' | 'disable';
export type SkillView = 'current' | 'proposals' | 'history';
export function skillStatusLabel(status: Skill['status']) {
  return {
    active: uiText('common:text_5ddff4afab27'),
    proposed: uiText('common:text_a8b0bd9c65f7'),
    archived: uiText('common:text_6fd29579ab66'),
    disabled: uiText('common:text_a8c3698b5b8c'),
  }[status];
}
export function skillAction(skill: Skill): SkillAction {
  return skill.status === 'proposed'
    ? 'approve'
    : skill.status === 'active'
      ? 'disable'
      : 'restore';
}
export function currentSkillVersion(skills: Skill[], target: Skill): Skill | undefined {
  return skills.find(
    (item) =>
      item.agentId === target.agentId && item.name === target.name && item.status === 'active',
  );
}
export function skillVersionsInView(skills: Skill[], view: SkillView) {
  return skills
    .filter((skill) =>
      view === 'current'
        ? skill.status === 'active'
        : view === 'proposals'
          ? skill.status === 'proposed'
          : skill.status === 'archived' || skill.status === 'disabled',
    )
    .slice()
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, currentLanguage()) ||
        a.agentId.localeCompare(b.agentId) ||
        b.version - a.version,
    );
}
export function skillTransitionLabel(action: SkillAction) {
  return {
    approve: uiText('common:text_1e1a5e14d128'),
    restore: uiText('common:text_6fa02e4f345e'),
    disable: uiText('common:text_316875d4795c'),
  }[action];
}

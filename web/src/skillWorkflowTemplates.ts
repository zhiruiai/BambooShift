import type { Language } from './i18n/language';
import en from '../../mobile/assets/skills/en.json';
import zh from '../../mobile/assets/skills/zh.json';

export type SkillWorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  content: string;
};

export type PackagedSkillDraft = { agentId: string; recipe: SkillWorkflowTemplate };

export const skillWorkflowTemplates: Record<Language, readonly SkillWorkflowTemplate[]> = {
  'zh-CN': zh,
  en,
};

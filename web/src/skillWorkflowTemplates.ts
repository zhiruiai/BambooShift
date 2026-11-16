import type { Language } from './i18n/language';
import en from '../../mobile/assets/skills/en.json';
import zh from '../../mobile/assets/skills/zh.json';
import resourceCatalog from '../../shared/skill-workflow-resources.json';
import { skillPackageFile, type ImportedSkillPackage } from './skillPackageImport';

export type SkillWorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  content: string;
};

export type PackagedSkillDraft = { agentId: string; skill: ImportedSkillPackage };

type WorkflowResources = {
  files: Record<string, string>;
  instruction: Record<Language, string>;
  source?: string;
  license?: string;
  compatibility?: string;
};
const resources: Record<string, WorkflowResources> = resourceCatalog;

export const skillWorkflowTemplates: Record<Language, readonly SkillWorkflowTemplate[]> = {
  'zh-CN': zh,
  en,
};

export function skillWorkflowPackage(recipe: SkillWorkflowTemplate, language: Language) {
  const { files, instruction, source, license, compatibility } = resources[recipe.id];
  const encoder = new TextEncoder();
  const draft: ImportedSkillPackage = {
    name: recipe.id,
    description: recipe.description,
    content: `${recipe.content.trimEnd()}\n\n${instruction[language]}\n`,
    skillPackage: {
      root: recipe.id,
      frontmatter: {
        ...(license ? { license } : {}),
        ...(compatibility ? { compatibility } : {}),
        metadata: { title: recipe.name, ...(source ? { source } : {}) },
      },
      files: Object.entries(files).map(([path, content]) =>
        skillPackageFile(path, encoder.encode(content)),
      ),
    },
  };
  return { draft, fileContents: files };
}

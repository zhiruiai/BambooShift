import packsSource from '../../shared/starter-skill-packs.json';
import type { Language } from './i18n/language';
import { skillWorkflowTemplates } from './skillWorkflowTemplates';

type Pack = {
  name: string;
  description: string;
  instructions: string;
  checklist: string[];
};
const catalog: {
  bots: Record<string, string[]>;
  teams: Record<string, Record<string, string[]>>;
  packs: Record<string, { locales: Record<Language, Pack> }>;
} = packsSource;

function localPacks(ids: string[] | undefined, language: Language) {
  if (!ids) return [];
  return [...new Set([...ids, ...packsSource.foundation])].map((id) => {
    const starter = catalog.packs[id]?.locales[language];
    if (starter) return { id, ...starter };
    const recipe = skillWorkflowTemplates[language].find((item) => item.id === id);
    if (!recipe) throw new Error(`Missing bundled skill: ${id}`);
    return {
      id,
      name: recipe.name,
      description: recipe.description,
      instructions: recipe.content,
      checklist: [],
    };
  });
}

export const starterBotPacks = (id: string, language: Language) =>
  localPacks(catalog.bots[id], language);
export const starterTeamMemberPacks = (id: string, member: string, language: Language) =>
  localPacks(catalog.teams[id]?.[member], language);

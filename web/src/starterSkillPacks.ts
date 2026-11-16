import packsSource from '../../shared/starter-skill-packs.json';
import type { Language } from './i18n/language';

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
  return (ids || []).map((id) => ({ id, ...catalog.packs[id].locales[language] }));
}

export const starterBotPacks = (id: string, language: Language) =>
  localPacks(catalog.bots[id], language);
export const starterTeamMemberPacks = (id: string, member: string, language: Language) =>
  localPacks(catalog.teams[id]?.[member], language);

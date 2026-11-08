import catalog from '../../shared/bot-starter-templates.json';
import type { BotProfileDraft } from './botProfiles';
import { currentLanguage, uiText } from './i18n';
export type StarterCategory = keyof typeof catalog;
export const starterCategories = Object.keys(catalog) as StarterCategory[];
export type StarterTemplate = {
  id: StarterCategory;
  category: StarterCategory;
  profile: BotProfileDraft;
};
export function starterCategoryLabel(category: StarterCategory | 'all') {
  return category === 'all'
    ? uiText('workspace:starterAll')
    : catalog[category].locales[currentLanguage()].category;
}
export function starterTemplates(): StarterTemplate[] {
  const language = currentLanguage();
  return starterCategories.map((id) => {
    const { avatar, color, locales } = catalog[id];
    const { name, role, description, instructions } = locales[language];
    return {
      id,
      category: id,
      profile: {
        name,
        role,
        description,
        instructions,
        avatar: avatar as BotProfileDraft['avatar'],
        color,
        avatarImageId: null,
      },
    };
  });
}
export function filterStarterTemplates(
  templates: StarterTemplate[],
  query: string,
  category: StarterCategory | 'all',
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter(
    (item) =>
      (category === 'all' || item.category === category) &&
      words.every((word) =>
        `${item.profile.name} ${item.profile.role} ${item.profile.description} ${item.profile.instructions}`
          .toLocaleLowerCase()
          .includes(word),
      ),
  );
}

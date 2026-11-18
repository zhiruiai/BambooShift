import en from './catalogs/en/entry.json';
import zh from './catalogs/zh-CN/entry.json';
import { translate, type CatalogKey } from './runtime';

export { currentLanguage, languageHeaders } from './runtime';
export const accountCatalog = { en, 'zh-CN': zh };
export type AccountTextKey = CatalogKey<typeof zh>;
export function uiText(key: AccountTextKey, values?: Record<string, unknown>) {
  return translate(accountCatalog, key, values);
}

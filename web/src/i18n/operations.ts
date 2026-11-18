import en from './catalogs/en/operations.json';
import zh from './catalogs/zh-CN/operations.json';
import { accountCatalog, type AccountTextKey } from './account';
import { currentLanguage, registerCatalog, translate, type CatalogKey } from './runtime';

export { localizedData } from './runtime';
const operationsCatalog = { en, 'zh-CN': zh };
export function uiText(
  key: CatalogKey<typeof zh> | AccountTextKey,
  values?: Record<string, unknown>,
) {
  registerCatalog(accountCatalog, currentLanguage());
  return translate(operationsCatalog, key, values);
}

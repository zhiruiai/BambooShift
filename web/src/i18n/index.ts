import { uiResources } from './resources';
import { translate, type CatalogKey } from './runtime';
export {
  currentLanguage,
  formatDate,
  formatNumber,
  initializeLanguage,
  languageHeaders,
  localizedData,
} from './runtime';
import zhCommon from './catalogs/zh-CN/common';
import enCommon from './catalogs/en/common';
import zhSettings from './catalogs/zh-CN/settings';
import enSettings from './catalogs/en/settings';

export const resources = {
  'zh-CN': {
    ...uiResources['zh-CN'],
    common: { ...uiResources['zh-CN'].common, ...zhCommon },
    settings: { ...uiResources['zh-CN'].settings, ...zhSettings },
  },
  en: {
    ...uiResources.en,
    common: { ...uiResources.en.common, ...enCommon },
    settings: { ...uiResources.en.settings, ...enSettings },
  },
};
export type UiNamespace = keyof (typeof resources)['zh-CN'];
export type UiTextKey = CatalogKey<(typeof resources)['zh-CN']>;
export function uiText(key: UiTextKey, values?: Record<string, unknown>): string {
  return translate(resources, key, values);
}

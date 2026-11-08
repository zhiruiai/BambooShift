import type { resources } from './index';
import 'i18next';
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: (typeof resources)['zh-CN'];
  }
}

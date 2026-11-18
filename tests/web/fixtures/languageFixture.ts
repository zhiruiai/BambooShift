import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import React from 'react';

const require = createRequire(import.meta.url);
export const languageSources = `
export { initializeLanguage, uiText, languageHeaders, localizedData, formatDate, formatNumber } from './i18n';
export { LanguageSettings } from './components/LanguageSettings';
export { BotProfileFields } from './components/BotProfileFields';
export { RemoteShellDetails, RemoteShellResult } from './components/RemoteShellDetails';
export { AccountShell } from './platform/account/AccountShell';
export { AppearanceSettings } from './components/AppearanceSettings';
export { AppActionCard } from './components/AppActionCard';
export { RoutineDetails } from './components/RoutineDetails';
export { routineScheduleLabel } from './routineLabels';
export { calendarLabel } from './dates';
export { displayTimeZone } from './timeZones';
export { primaryBotSummary } from './components/PrimaryBotEntry';
export { createAppConnectionScope } from './appConnections';
export { useAgentSettingsContent } from './components/agent/useAgentSettingsContent';
export { AgentSettingsContentView } from './components/agent/AgentSettingsContentView';
`;
export async function languageFixture(overrides: Record<string, unknown> = {}) {
  const output = await build({
    stdin: { contents: languageSources, resolveDir: resolve('web/src'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const values = new Map<string, string>();
  const events = Object.assign(new EventTarget(), {
    location: { pathname: '/w/space-a/' },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const root = { lang: '', dataset: {}, style: {} };
  const module = { exports: {} as Record<string, any> };
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    console,
    window: events,
    document: { documentElement: root },
    Error,
    DOMException,
    AbortController,
    AbortSignal,
    Response,
    URL,
    TextEncoder,
    ...overrides,
  });
  return { api: module.exports, root, values, events };
}
export function nodes(tree: any, predicate: (item: any) => boolean): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
export function languageHooks() {
  let cursor = 0;
  const slots: any[] = [],
    cleanups: Array<() => void> = [];
  return {
    render<T>(work: () => T): T {
      cursor = 0;
      return work();
    },
    dispose() {
      for (const clean of cleanups.splice(0)) clean();
    },
    require(name: string) {
      if (name !== 'react') return require(name);
      return {
        ...React,
        useRef(value: unknown) {
          const key = cursor++;
          return (slots[key] ||= { current: value });
        },
        useState(initial: any) {
          const key = cursor++;
          if (!(key in slots))
            slots[key] = { value: typeof initial === 'function' ? initial() : initial };
          return [
            slots[key].value,
            (update: any) => {
              slots[key].value = typeof update === 'function' ? update(slots[key].value) : update;
            },
          ];
        },
        useEffect(effect: () => (() => void) | undefined, deps?: unknown[]) {
          const key = cursor++,
            previous = slots[key];
          if (
            !previous ||
            !deps ||
            deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
          ) {
            previous?.cleanup?.();
            const cleanup = effect();
            slots[key] = { deps, cleanup };
            if (cleanup) cleanups.push(cleanup);
          }
        },
        useSyncExternalStore(subscribe: (listener: () => void) => () => void, get: () => unknown) {
          const key = cursor++;
          if (!slots[key]) {
            slots[key] = true;
            cleanups.push(subscribe(() => {}));
          }
          return get();
        },
      };
    },
  };
}

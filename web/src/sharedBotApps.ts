import { serviceText } from './i18n/serviceText';
import { uiText } from './i18n';
import {
  SHARED_APP_CONNECTIONS,
  SHARED_APP_TOOLS,
  SHARED_BOT_ID,
  type SharedBotAppGrant,
  type SharedBotAppSelection,
  type SharedBotAppView,
} from '../../shared/shared-bots';

const id = /^[A-Za-z0-9_-]{1,128}$/;
const revision = /^[a-f\d]{64}$/;
export function sharedAppSelections(value: unknown): value is SharedBotAppSelection[] {
  if (!Array.isArray(value) || value.length > SHARED_APP_CONNECTIONS) return false;
  const connections = new Set<string>();
  return value.every((app) => {
    if (
      !app ||
      typeof app !== 'object' ||
      Array.isArray(app) ||
      Object.keys(app).some(
        (key) => !['connectionId', 'connectionRevision', 'tools'].includes(key),
      ) ||
      typeof app.connectionId !== 'string' ||
      !id.test(app.connectionId) ||
      connections.has(app.connectionId) ||
      typeof app.connectionRevision !== 'string' ||
      !SHARED_BOT_ID.test(app.connectionRevision) ||
      !Array.isArray(app.tools) ||
      !app.tools.length ||
      app.tools.length > SHARED_APP_TOOLS
    )
      return false;
    connections.add(app.connectionId);
    const names = new Set<string>();
    return app.tools.every((tool: any) => {
      if (
        !tool ||
        typeof tool !== 'object' ||
        Array.isArray(tool) ||
        Object.keys(tool).some((key) => !['name', 'revision'].includes(key)) ||
        typeof tool.name !== 'string' ||
        !tool.name.trim() ||
        names.has(tool.name) ||
        typeof tool.revision !== 'string' ||
        !revision.test(tool.revision)
      )
        return false;
      names.add(tool.name);
      return true;
    });
  });
}
export const appSelections = (apps: SharedBotAppGrant[]): SharedBotAppSelection[] =>
  apps.map(({ connectionId, connectionRevision, tools }) => ({
    connectionId,
    connectionRevision,
    tools: tools.map(({ name, revision }) => ({ name, revision })),
  }));
export function sharedAppProblem(apps: SharedBotAppGrant[]) {
  return sharedAppSelections(appSelections(apps))
    ? ''
    : uiText('apps:text_8e49ea846a66', {
        value0: SHARED_APP_CONNECTIONS,
        value1: SHARED_APP_TOOLS,
      });
}
export function sharedAppStatus(app: SharedBotAppView) {
  return (
    serviceText(app.reason) ||
    {
      available: uiText('apps:text_a8dd78e6e3cc'),
      changed: uiText('apps:text_0f4f56b37188'),
      missing: uiText('apps:text_24c89632368f'),
      unavailable: uiText('apps:text_ae72a46c429e'),
    }[app.status]
  );
}

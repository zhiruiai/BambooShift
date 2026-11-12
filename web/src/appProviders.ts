import catalog from '../../shared/app-providers.json';
import type { ConnectedApp } from '../../shared/app-connections';
export type AppProvider = {
  id: string;
  name: string;
  category: 'productivity' | 'code';
  mark: string;
  url: string;
  keywords: string;
  authType: ConnectedApp['authType'];
  descriptionKey:
    | 'providerNotion'
    | 'providerLinear'
    | 'providerGitHub'
    | 'providerSentry'
    | 'providerAtlassian'
    | 'providerSlack'
    | 'providerGitLab'
    | 'providerMicrosoftLearn'
    | 'providerCloudflareDocs'
    | 'providerDeepWiki'
    | 'providerContext7'
    | 'providerAwsKnowledge';
  documentation: string;
};
// Provider-owned endpoints verified against their published documentation.
export const appProviders = catalog as readonly AppProvider[];
const address = (value: string) => value.replace(/\/$/, '');
export function providerConnection(provider: AppProvider, apps: ConnectedApp[]) {
  return (
    apps.find((app) => address(app.url) === address(provider.url) && app.status === 'connected') ||
    apps.find((app) => address(app.url) === address(provider.url))
  );
}
export function providerDraft(id: string) {
  const provider = appProviders.find((item) => item.id === id);
  if (!provider) return;
  return {
    name: provider.name,
    url: provider.url,
    authType: provider.authType,
    token: '',
    shared: false,
  };
}

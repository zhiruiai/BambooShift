import { ArrowUpRight, Check, Plus } from 'lucide-react';
import type { ConnectedApp } from '../../../../shared/app-connections';
import { appProviders, providerConnection } from '../../appProviders';
import { uiText } from '../../i18n';
import './AppProviderCatalog.css';

const categories = ['all', 'productivity', 'code'] as const;
export type ProviderCategory = (typeof categories)[number];

export function ProviderCategoriesView({
  category,
  onChange,
}: {
  category: ProviderCategory;
  onChange: (value: ProviderCategory) => void;
}) {
  return (
    <div
      className="provider-categories"
      role="group"
      aria-label={uiText('workspace:providerCategories')}
    >
      {categories.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={category === value}
          onClick={() => onChange(value)}
        >
          {uiText(`workspace:providerCategory_${value}`)}
        </button>
      ))}
    </div>
  );
}

export function AppProviderCatalog({
  apps,
  category,
  search,
  canManage,
  busy,
  onSelect,
  onOpen,
}: {
  apps: ConnectedApp[];
  category: ProviderCategory;
  search: string;
  canManage: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const providers = appProviders.filter(
    (provider) =>
      (category === 'all' || provider.category === category) &&
      `${provider.name} ${provider.url} ${provider.keywords} ${uiText(`workspace:${provider.descriptionKey}`)}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <section className="provider-catalog" aria-label={uiText('workspace:providerCatalog')}>
      <h3>{uiText('workspace:providerCatalog')}</h3>
      <p className="field-help">{uiText('workspace:providerCatalogHelp')}</p>
      {providers.length ? (
        <div className="provider-grid">
          {providers.map((provider) => {
            const app = providerConnection(provider, apps);
            const connected = app?.status === 'connected';
            const actionLabel = uiText(
              connected ? 'workspace:providerConnectedLabel' : 'workspace:providerConfigureLabel',
              { name: provider.name },
            );
            return (
              <article key={provider.id} className="provider-card">
                <span className="provider-mark" aria-hidden="true">
                  {provider.mark}
                </span>
                <strong className="provider-title">{provider.name}</strong>
                <p className="provider-description">
                  {uiText(`workspace:${provider.descriptionKey}`)}
                </p>
                <div className="provider-card-actions">
                  <a
                    href={provider.documentation}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={uiText('workspace:providerDocumentationLabel', {
                      name: provider.name,
                    })}
                    title={uiText('workspace:providerDocumentationLabel', { name: provider.name })}
                  >
                    <span>{uiText('workspace:providerDocumentation')}</span>
                    <ArrowUpRight size={12} />
                  </a>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || (!app && !canManage)}
                    aria-label={actionLabel}
                    title={actionLabel}
                    onClick={() => (app ? onOpen(app.id) : onSelect(provider.id))}
                  >
                    {connected ? <Check size={14} /> : <Plus size={14} />}
                    <span>
                      {uiText(
                        connected
                          ? 'workspace:providerConnected'
                          : app
                            ? 'workspace:providerContinue'
                            : 'workspace:providerConfigure',
                      )}
                    </span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="field-help">{uiText('workspace:providerNoResults')}</p>
      )}
    </section>
  );
}

import { uiText } from '../../i18n';
import {
  BookOpen,
  ChevronRight,
  FolderOpen,
  LibraryBig,
  Link2,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { appConnectionStatus } from '../../appConnections';
import type { ReactNode } from 'react';
import '../AppsDialog.css';
import './AppApprovalRules.css';
import { SharedBotApps } from '../SharedBotApps';
import { EnvironmentLink } from './parts';
import { AppProviderCatalog, ProviderCategoriesView } from './AppProviderCatalog';
import type { useAppsDialogContent } from './useAppsDialogContent';
export type AppsDialogContentModel = ReturnType<typeof useAppsDialogContent>;
export function AppConnectionsListView({
  feedback,
  ...model
}: AppsDialogContentModel & { feedback: ReactNode }) {
  const {
    props,
    busy,
    navigate,
    uncertain,
    loading,
    refresh,
    search,
    setSearch,
    category,
    setCategory,
    listScroll,
    apps,
    visible,
  } = model;
  const publisher = props.userId && (!!props.sharedAgents?.length || props.initialSharedBotId) && (
    <section className="apps-publisher-section">
      <h3>{uiText('apps:text_ba5cca0e959c')}</h3>
      {props.initialSharedBotId &&
        !props.sharedAgents?.some(
          (agent) => agent.sharedBot?.shareId === props.initialSharedBotId,
        ) && <p className="field-help">{uiText('apps:text_223e890bf71e')}</p>}
      {[...(props.sharedAgents || [])]
        .sort(
          (a, b) =>
            Number(b.sharedBot?.shareId === props.initialSharedBotId) -
            Number(a.sharedBot?.shareId === props.initialSharedBotId),
        )
        .map((agent) => (
          <SharedBotApps key={agent.id} agent={agent} userId={props.userId!} />
        ))}
    </section>
  );
  return (
    <>
      <div className="apps-list-toolbar">
        <label className="apps-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={uiText('apps:text_a815ff000266')}
            aria-label={uiText('apps:text_a815ff000266')}
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || loading}
          onClick={() => void refresh()}
          aria-label={uiText('apps:text_43455c9d5f80')}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} aria-hidden="true" />
        </button>
        {props.canManage && (
          <button
            type="button"
            className="primary-button"
            disabled={busy || uncertain}
            onClick={() => navigate('add')}
          >
            <Plus size={15} aria-hidden="true" />
            {uiText('apps:text_7a8a11ead507')}
          </button>
        )}
        <ProviderCategoriesView category={category} onChange={setCategory} />
      </div>
      <div className="apps-scroll" ref={listScroll}>
        {feedback}
        {(props.packagedSkills || model.personalOwner) && (
          <div className="apps-private-tools">
            {props.packagedSkills && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => navigate('packaged-skills')}
              >
                <LibraryBig size={16} aria-hidden="true" />
                {uiText('workspace:packagedSkillsTitle')}
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            )}
            {model.personalOwner && (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => navigate('rules')}
                >
                  <ShieldCheck size={16} aria-hidden="true" />
                  {uiText('apps:approvalRulesTitle')}
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => navigate('skills')}
                >
                  <BookOpen size={16} aria-hidden="true" />
                  {uiText('apps:privateSkillsTitle')}
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        )}
        {props.initialSharedBotId && publisher}
        <AppProviderCatalog
          apps={apps}
          category={category}
          search={search}
          canManage={props.canManage}
          busy={busy || uncertain}
          onSelect={model.selectProvider}
          onOpen={(id) => navigate('detail', id)}
        />
        <section
          className="apps-workspace-connections"
          aria-label={uiText('apps:text_cb74a861cb66')}
        >
          <h3>{uiText('apps:text_cb74a861cb66')}</h3>
          {loading && !apps.length ? (
            <p className="apps-connections-empty" role="status">
              <Loader2 size={16} className="spin" aria-hidden="true" />
              {uiText('apps:text_d5bf3e74fdb1')}
            </p>
          ) : visible.length ? (
            <div className="integration-list apps-connection-items">
              {visible.map((app) => (
                <button
                  type="button"
                  className="integration"
                  key={app.id}
                  onClick={() => navigate('detail', app.id)}
                >
                  <span className="integration-icon lavender">
                    <Link2 size={18} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{app.name}</strong>
                    <small>{app.url}</small>
                  </span>
                  <span className={`integration-status app-status-${app.status}`}>
                    {appConnectionStatus(app.status)}
                    <ChevronRight size={14} aria-hidden="true" />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="apps-connections-empty" role="status">
              <Link2 size={16} aria-hidden="true" />
              {search.trim() ? uiText('apps:text_61f00459f7b7') : uiText('apps:text_2101ac3a8835')}
            </p>
          )}
        </section>
        {!props.initialSharedBotId && publisher}
      </div>
      <footer className="apps-environment" aria-label={uiText('apps:text_7958d84e9a3f')}>
        <h3>{uiText('apps:text_7958d84e9a3f')}</h3>
        <div className="apps-environment-grid">
          {props.onTemplates && (
            <EnvironmentLink
              icon={<BookOpen size={20} />}
              title={uiText('apps:text_9f42185e17cb')}
              text={uiText('apps:text_7e54691e948c')}
              onClick={props.onTemplates}
            />
          )}
          <EnvironmentLink
            icon={<FolderOpen size={18} />}
            title={uiText('apps:text_1253f60c45f5')}
            text={uiText('apps:text_acfb4e262968')}
            onClick={props.onFiles}
          />
          <EnvironmentLink
            icon={<Monitor size={18} />}
            title={uiText('apps:text_6205c8a9a2b9')}
            text={
              props.computerConnected
                ? uiText('apps:text_68c54cc72780')
                : uiText('apps:text_2a097c4de9ca')
            }
            onClick={props.onComputer}
          />
          <EnvironmentLink
            icon={<Sparkles size={18} />}
            title={uiText('apps:text_23a052718902')}
            text={
              props.modelConfigured
                ? props.modelLabel
                : props.canManage
                  ? uiText('apps:text_512212d52261')
                  : uiText('apps:text_c81d5f0c9971')
            }
            onClick={props.onSettings}
          />
        </div>
      </footer>
    </>
  );
}

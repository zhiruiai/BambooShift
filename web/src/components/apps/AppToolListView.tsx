import { RefreshCw } from 'lucide-react';
import { uiText } from '../../i18n';
import { AppToolDetails } from '../sharedApps/AppToolDetails';
import { toolAccess, type useAppsDialogContent } from './useAppsDialogContent';

export function AppToolListView({
  selectedApp,
  tools,
  toolsLoading,
  toolsError,
  toolIssue,
  canEditToolAccess,
  changeToolAccess,
  busy,
  loading,
  uncertain,
  refresh,
}: Pick<
  ReturnType<typeof useAppsDialogContent>,
  | 'selectedApp'
  | 'tools'
  | 'toolsLoading'
  | 'toolsError'
  | 'toolIssue'
  | 'canEditToolAccess'
  | 'changeToolAccess'
  | 'busy'
  | 'loading'
  | 'uncertain'
  | 'refresh'
>) {
  if (!selectedApp) return null;
  const supportsAccess = selectedApp.toolAccessSupported === true;
  const connected = selectedApp.status === 'connected';
  const disabled = busy || loading || toolsLoading || uncertain || !!toolsError || !!toolIssue;
  return (
    <section className="apps-tools">
      <div className="apps-tools-heading">
        <h3>
          {uiText('apps:text_0cf19eff1dfa')}
          <span>{selectedApp.toolCount}</span>
        </h3>
        {connected && supportsAccess && (
          <button
            type="button"
            className="text-button apps-tools-refresh"
            disabled={busy || loading || toolsLoading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {uiText('apps:toolAccessRefresh')}
          </button>
        )}
      </div>
      <p className="field-help">
        {uiText(supportsAccess ? 'apps:toolAccessHelp' : 'apps:text_6b815ba15ad4')}
      </p>
      {toolIssue && (
        <p role="alert" className="apps-tool-feedback">
          {uiText(toolIssue === 'changed' ? 'apps:toolAccessChanged' : 'apps:toolAccessUncertain')}
        </p>
      )}
      {toolsLoading ? (
        <p role="status">{uiText('apps:text_4c6fabc9cd94')}</p>
      ) : toolsError ? (
        <p className="error-text" role="alert">
          {toolsError}
        </p>
      ) : !connected ? (
        <p className="field-help">{uiText('apps:text_eb7fb77f78c5')}</p>
      ) : !tools.length ? (
        <p className="field-help">{uiText('apps:text_9aaff2b19a95')}</p>
      ) : (
        tools.map((tool) => {
          const access = supportsAccess ? toolAccess(tool) : undefined;
          if (!access) return <AppToolDetails key={tool.name} tool={tool} />;
          const status = uiText(access.enabled ? 'apps:toolAccessOn' : 'apps:toolAccessOff');
          return (
            <div className="apps-tool-row" key={tool.name}>
              <AppToolDetails tool={tool} />
              {canEditToolAccess ? (
                <button
                  type="button"
                  className="apps-tool-switch"
                  role="switch"
                  aria-label={uiText('apps:toolAccessLabel', { tool: tool.name })}
                  aria-checked={access.enabled}
                  disabled={disabled}
                  onClick={() => void changeToolAccess(tool, !access.enabled)}
                >
                  <span>{status}</span>
                  <span className={`toggle${access.enabled ? ' on' : ''}`} aria-hidden="true">
                    <span />
                  </span>
                </button>
              ) : (
                <span className="apps-tool-status">{status}</span>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

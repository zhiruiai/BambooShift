import { uiText } from '../../i18n';
import type { ConnectedAppTool } from '../../../../shared/app-connections';
import '../SharedBots.css';
export function AppToolDetails({ tool }: { tool: ConnectedAppTool }) {
  return (
    <details className="shared-app-tool-description">
      <summary>{tool.name}</summary>
      <p>{tool.description || uiText('apps:text_b23ae6f8d54b')}</p>
      <details>
        <summary>{uiText('apps:text_d44966cf957f')}</summary>
        <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
      </details>
    </details>
  );
}

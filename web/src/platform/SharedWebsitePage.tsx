import { House, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { websiteSharePath } from '../../../shared/website-shares';
import { WebsiteProjectPreview } from '../components/WebsiteProjectPreview';
import { uiText } from '../i18n';
import {
  loadWebsiteProjectAssets,
  parseWebsiteProject,
  projectManifest,
  readWebsiteProjectResponse,
  type WebsiteProjectFile,
  type WebsiteProjectSummary,
} from '../websiteProjects';
import { accountEntryPath } from './platformApi';
import './SharedWebsitePage.css';

type State =
  | { kind: 'loading' | 'login' | 'unavailable' | 'error' }
  | { kind: 'ready'; project: WebsiteProjectSummary; files: WebsiteProjectFile[] };

export default function SharedWebsitePage({ token }: { token?: string }) {
  const [state, setState] = useState<State>({ kind: token ? 'loading' : 'unavailable' });
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState('');
  const navigate = useCallback((path: string) => setEntry(path), []);
  useEffect(() => {
    if (!token) return;
    let visible: Extract<State, { kind: 'ready' }> | undefined;
    const controller = new AbortController();
    const endpoint = `/api/public/website-projects/${token}`;
    let pending = false;
    const refresh = async () => {
      if (pending || controller.signal.aborted || document.hidden) return;
      pending = true;
      const request = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        request.signal,
        AbortSignal.timeout(30_000),
      ]);
      const fetchAsset = (path: string) =>
        fetch(endpoint + path, {
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal,
        });
      const guard = () => signal.throwIfAborted();
      const reset = (kind: 'login' | 'unavailable' | 'error') => {
        visible = undefined;
        if (!controller.signal.aborted) setState({ kind });
      };
      try {
        const manifest = await fetchAsset('');
        guard();
        if ([401, 403, 404, 410].includes(manifest.status)) {
          void manifest.body?.cancel();
          reset(manifest.status === 401 ? 'login' : 'unavailable');
          return;
        }
        const bytes = await readWebsiteProjectResponse(
          manifest,
          'application/json',
          64 * 1024,
          guard,
        );
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const project = parseWebsiteProject(value);
        if (!project) throw Error('Invalid shared website project');
        const assets = projectManifest(project, value);
        if (visible?.project.id === project.id) return;
        setState({ kind: 'loading' });
        const files = await loadWebsiteProjectAssets(
          assets,
          async (path, size) => {
            const asset = await fetchAsset(`/versions/${project.id}/files/${path}`);
            return readWebsiteProjectResponse(asset, 'application/octet-stream', size, guard);
          },
          guard,
        );
        guard();
        visible = { kind: 'ready', project, files };
        setEntry(project.entry);
        setState(visible);
      } catch {
        if (!controller.signal.aborted) reset('error');
      } finally {
        pending = false;
        request.abort();
      }
    };
    setState({ kind: 'loading' });
    void refresh();
    const interval = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [attempt, token]);

  return (
    <main className="shared-website-page">
      <header>
        <h1>
          {state.kind === 'ready' ? state.project.title : uiText('workspace:websiteSharePage')}
        </h1>
        {state.kind === 'ready' && entry !== state.project.entry && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => navigate(state.project.entry)}
          >
            <House size={16} aria-hidden="true" />
            {uiText('workspace:websiteReturnToEntry')}
          </button>
        )}
      </header>
      {state.kind === 'ready' ? (
        <WebsiteProjectPreview files={state.files} entryPath={entry} onNavigate={navigate} />
      ) : (
        <div className="shared-website-status">
          <p role={state.kind === 'error' ? 'alert' : 'status'}>
            {uiText(
              state.kind === 'login'
                ? 'workspace:websiteShareLoginRequired'
                : state.kind === 'unavailable'
                  ? 'workspace:websiteShareUnavailable'
                  : state.kind === 'error'
                    ? 'workspace:websiteLoadFailed'
                    : 'workspace:websiteLoading',
            )}
          </p>
          {state.kind === 'login' && token && (
            <a className="primary-button" href={accountEntryPath('login', websiteSharePath(token))}>
              {uiText('workspace:websiteShareSignIn')}
            </a>
          )}
          {state.kind === 'error' && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setAttempt(attempt + 1)}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {uiText('workspace:filePreviewRetry')}
            </button>
          )}
        </div>
      )}
    </main>
  );
}

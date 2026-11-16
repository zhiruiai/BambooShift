import { Download, FileText, History, House, Pencil, RefreshCw, Share2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message } from '../../../shared/types';
import { uiText } from '../i18n';
import type {
  WebsiteProjectFile,
  WebsiteProjectSummary,
  WebsiteProjectVersion,
  WebsiteProjectViewState,
} from '../websiteProjects';
import { Dialog, IconButton } from './UI';
import { WebsiteProjectPreview } from './WebsiteProjectPreview';
import { WebsiteVersionHistory, websiteVersionNumber } from './WebsiteVersionHistory';
import './WebsiteProjectPanel.css';

const modeLabels = {
  preview: 'workspace:filePreviewTab',
  source: 'workspace:filePreviewSource',
  changes: 'workspace:websiteVersionChanges',
} as const;
type Mode = keyof typeof modeLabels;

export function useProjectOverlay() {
  const query = '(max-width: 900px)';
  const [overlay, setOverlay] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setOverlay(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return overlay;
}

function fileSource(file: WebsiteProjectFile): string | undefined {
  if (
    !file.mime.startsWith('text/') &&
    file.mime !== 'application/json' &&
    file.mime !== 'image/svg+xml'
  )
    return;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    return;
  }
}

function WebsiteSource({
  files,
  selected,
  onSelect,
}: {
  files: WebsiteProjectFile[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  const file = files.find(({ path }) => path === selected) || files[0];
  const content = useMemo(() => (file ? fileSource(file) : undefined), [file]);
  if (!file) return <p className="website-project-status">{uiText('workspace:websiteNoFiles')}</p>;
  return (
    <div className="website-project-source">
      <nav
        className="website-project-file-list"
        aria-label={uiText('workspace:websiteProjectFiles')}
      >
        <ul>
          {files.map(({ path }) => (
            <li key={path}>
              <button
                type="button"
                aria-current={file.path === path ? 'true' : undefined}
                onClick={() => onSelect(path)}
              >
                <FileText size={14} aria-hidden="true" />
                <span>{path}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="website-project-file" key={file.path}>
        <p className="website-project-path">{file.path}</p>
        {content === undefined ? (
          <p className="website-project-status">{uiText('workspace:websiteBinaryFile')}</p>
        ) : (
          <pre tabIndex={0} aria-label={file.path}>
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function WebsiteProjectPanel({
  project,
  state,
  onClose,
  onDiscuss,
  onRetry,
  onDownload,
  downloading,
  downloadFailed,
  versions,
  onOpenVersion,
  changes,
  onShare,
}: {
  project: WebsiteProjectSummary;
  state: WebsiteProjectViewState;
  onClose: () => void;
  onDiscuss: () => void;
  onRetry: () => void;
  onDownload: () => void;
  downloading: boolean;
  downloadFailed: boolean;
  versions?: WebsiteProjectVersion[];
  onOpenVersion?: (message: Message) => void;
  changes?: ReactNode;
  onShare?: () => void;
}) {
  const overlay = useProjectOverlay();
  const panel = useRef<HTMLElement>(null);
  const [activeMode, setMode] = useState<Mode>('preview');
  const [historyOpen, setHistoryOpen] = useState(false);
  const mode = activeMode === 'changes' && !changes ? 'preview' : activeMode;
  const modes: Mode[] = changes ? ['preview', 'source', 'changes'] : ['preview', 'source'];
  const showHistory = !!onOpenVersion && !!versions && versions.length > 1;
  const latest = versions?.[0];
  const newerDelivery = latest && latest.project.id !== project.id ? latest : undefined;
  const [entry, setEntry] = useState(project.entry);
  const [selected, setSelected] = useState(project.entry);
  const id = useId();
  const goTo = useCallback((path: string) => {
    setEntry(path);
    setSelected(path);
  }, []);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [overlay]);
  const downloadLabel = uiText(
    downloading ? 'workspace:websiteDownloading' : 'workspace:websiteDownload',
  );
  const versionLabel = `${uiText('workspace:websiteVersionCurrent')} · ${uiText(
    'workspace:websiteVersionNumber',
    { number: websiteVersionNumber(versions ?? [], project.id) ?? project.id.slice(0, 8) },
  )}${latest && !newerDelivery ? ` · ${uiText('workspace:websiteVersionLatest')}` : ''}`;
  const editLabel = uiText('workspace:websiteEditVersion');
  const actions = (
    <>
      <button
        type="button"
        className="website-project-action website-project-edit"
        onClick={onDiscuss}
        aria-label={editLabel}
        title={editLabel}
      >
        <Pencil size={16} aria-hidden="true" />
        <span>{editLabel}</span>
      </button>
      {onShare && (
        <button
          type="button"
          className="website-project-action"
          onClick={onShare}
          aria-label={uiText('workspace:websiteShare')}
          title={uiText('workspace:websiteShare')}
        >
          <Share2 size={17} aria-hidden="true" />
          <span>{uiText('workspace:websiteShare')}</span>
        </button>
      )}
      <button
        type="button"
        className="website-project-action"
        onClick={onDownload}
        disabled={downloading}
        aria-busy={downloading}
        aria-label={downloadLabel}
        title={downloadLabel}
      >
        <Download size={17} aria-hidden="true" />
        <span>{downloadLabel}</span>
      </button>
    </>
  );
  const content = (
    <>
      {newerDelivery && onOpenVersion && (
        <div className="website-project-latest" role="status">
          <span>
            {uiText('workspace:websiteNewDeliveryAvailable', { number: newerDelivery.number })}
          </span>
          <button
            type="button"
            className="website-project-action"
            onClick={() => onOpenVersion(newerDelivery.message)}
          >
            {uiText('workspace:websiteViewLatestDelivery')}
          </button>
        </div>
      )}
      <div className="website-project-toolbar">
        <div
          className="website-project-tabs"
          role="tablist"
          aria-label={uiText('workspace:filePreviewMode')}
          onKeyDown={(event) => {
            const index = modes.indexOf(mode);
            const positions: Record<string, number> = {
              Home: 0,
              End: modes.length - 1,
              ArrowLeft: (index + modes.length - 1) % modes.length,
              ArrowRight: (index + 1) % modes.length,
            };
            const next = positions[event.key];
            if (typeof next !== 'number') return;
            event.preventDefault();
            setMode(modes[next]);
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {modes.map((value) => (
            <button
              key={value}
              id={`${id}-${value}`}
              type="button"
              role="tab"
              aria-controls={`${id}-content`}
              aria-selected={mode === value}
              tabIndex={mode === value ? 0 : -1}
              onClick={() => setMode(value)}
            >
              {uiText(modeLabels[value])}
            </button>
          ))}
        </div>
        <div className="website-project-meta">
          <span>{uiText('workspace:websiteFileCount', { count: project.fileCount })}</span>
          {showHistory && (
            <button
              type="button"
              className="website-project-action"
              aria-expanded={historyOpen}
              aria-controls={`${id}-versions`}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <History size={15} aria-hidden="true" />
              {uiText('workspace:websiteVersionHistory')}
            </button>
          )}
        </div>
      </div>
      {showHistory && (
        <div id={`${id}-versions`} className="website-project-history" hidden={!historyOpen}>
          {historyOpen && (
            <WebsiteVersionHistory
              versions={versions}
              currentId={project.id}
              onOpen={onOpenVersion}
            />
          )}
        </div>
      )}
      {downloadFailed && (
        <p role="alert" className="website-project-notice">
          {uiText('workspace:websiteDownloadFailed')}
        </p>
      )}
      <div
        className="website-project-content"
        id={`${id}-content`}
        role="tabpanel"
        aria-labelledby={`${id}-${mode}`}
        aria-busy={mode !== 'changes' && state.kind === 'loading'}
      >
        {mode === 'changes' && changes}
        {mode !== 'changes' && state.kind === 'loading' && (
          <p role="status" className="website-project-status">
            {uiText('workspace:websiteLoading')}
          </p>
        )}
        {mode !== 'changes' && state.kind === 'error' && (
          <div className="website-project-status" role="alert">
            <p>{uiText('workspace:websiteLoadFailed')}</p>
            <button className="secondary-button" type="button" onClick={onRetry}>
              <RefreshCw size={15} aria-hidden="true" />
              {uiText('workspace:filePreviewRetry')}
            </button>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <div className="website-project-preview-pane" hidden={mode !== 'preview'}>
              {entry !== project.entry && (
                <div className="website-project-current-page">
                  <IconButton
                    label={uiText('workspace:websiteReturnToEntry')}
                    onClick={() => goTo(project.entry)}
                  >
                    <House size={15} />
                  </IconButton>
                  <span>{entry}</span>
                </div>
              )}
              <WebsiteProjectPreview files={state.files} entryPath={entry} onNavigate={goTo} />
            </div>
            {mode === 'source' && (
              <WebsiteSource files={state.files} selected={selected} onSelect={setSelected} />
            )}
          </>
        )}
      </div>
    </>
  );
  if (overlay) {
    return (
      <Dialog
        scrollBody={false}
        title={project.title}
        subtitle={versionLabel}
        className="website-project-panel website-project-overlay"
        portal
        wide
        onClose={onClose}
        headerActions={actions}
      >
        {content}
      </Dialog>
    );
  }
  return (
    <aside
      className="website-project-panel"
      aria-label={project.title}
      ref={panel}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      }}
    >
      <header className="website-project-header">
        <div className="website-project-heading">
          <h2 title={project.title}>{project.title}</h2>
          <p>{versionLabel}</p>
        </div>
        <div className="website-project-actions">
          {actions}
          <IconButton label={uiText('common:text_3fd47edce45b')} onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
      </header>
      {content}
    </aside>
  );
}

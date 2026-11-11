import { Download, FileText, House, MessageCircle, RefreshCw, Share2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { uiText } from '../i18n';
import type {
  WebsiteProjectFile,
  WebsiteProjectSummary,
  WebsiteProjectViewState,
} from '../websiteProjects';
import { Dialog, IconButton } from './UI';
import { WebsiteProjectPreview } from './WebsiteProjectPreview';
import './WebsiteProjectPanel.css';

const modes = ['preview', 'source'] as const;
type Mode = (typeof modes)[number];

function useProjectOverlay() {
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
  onOpenLatest,
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
  onOpenLatest?: () => void;
  onShare?: () => void;
}) {
  const overlay = useProjectOverlay();
  const panel = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<Mode>('preview');
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
  const actions = (
    <>
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
        onClick={onDiscuss}
        aria-label={uiText('workspace:websiteDiscuss')}
        title={uiText('workspace:websiteDiscuss')}
      >
        <MessageCircle size={17} aria-hidden="true" />
        <span>{uiText('workspace:websiteDiscuss')}</span>
      </button>
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
      <div className="website-project-toolbar">
        <div
          className="website-project-tabs"
          role="tablist"
          aria-label={uiText('workspace:filePreviewMode')}
          onKeyDown={(event) => {
            const next =
              event.key === 'Home'
                ? 'preview'
                : event.key === 'End'
                  ? 'source'
                  : ['ArrowLeft', 'ArrowRight'].includes(event.key)
                    ? mode === 'preview'
                      ? 'source'
                      : 'preview'
                    : undefined;
            if (!next) return;
            event.preventDefault();
            setMode(next);
            event.currentTarget
              .querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [modes.indexOf(next)]?.focus();
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
              {uiText(
                value === 'preview' ? 'workspace:filePreviewTab' : 'workspace:filePreviewSource',
              )}
            </button>
          ))}
        </div>
        <div className="website-project-meta">
          <span>{uiText('workspace:websiteFileCount', { count: project.fileCount })}</span>
          {onOpenLatest && (
            <button type="button" className="website-project-action" onClick={onOpenLatest}>
              {uiText('workspace:websiteNewVersion')}
            </button>
          )}
        </div>
      </div>
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
        aria-busy={state.kind === 'loading'}
      >
        {state.kind === 'loading' && (
          <p role="status" className="website-project-status">
            {uiText('workspace:websiteLoading')}
          </p>
        )}
        {state.kind === 'error' && (
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
            <div className="website-project-preview-pane" hidden={mode === 'source'}>
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
        <h2 title={project.title}>{project.title}</h2>
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

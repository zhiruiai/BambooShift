import { useEffect, useId, useRef, useState } from 'react';
import { Download, RefreshCw, ShieldCheck } from 'lucide-react';
import { Dialog } from './UI';
import { currentLanguage, uiText } from '../i18n';
import { createFilePreview, type FilePreviewIdentity, type FilePreviewState } from '../filePreview';
import { renderHtmlPreview } from '../staticHtmlPreview';
import { FormattedFilePreview, RasterFilePreview } from './FormattedFilePreview';
import './FilePreviewDialog.css';

export function FilePreviewDialog({
  name,
  href,
  identity,
  currentIdentity,
  onClose,
}: {
  name: string;
  href: string;
  identity: FilePreviewIdentity;
  currentIdentity: () => FilePreviewIdentity;
  onClose: () => void;
}) {
  const [state, setState] = useState<FilePreviewState>({ status: 'loading' });
  const [tab, setTab] = useState<'preview' | 'source'>('preview');
  const panelId = useId();
  const [document, setDocument] = useState<ReturnType<typeof renderHtmlPreview>>();
  const preview = useRef<ReturnType<typeof createFilePreview> | undefined>(undefined);
  useEffect(() => {
    const controller = createFilePreview({
      name,
      href,
      identity,
      currentIdentity,
      onChange(next) {
        if (next.status === 'ready' && next.content.kind === 'html') {
          try {
            setDocument(
              renderHtmlPreview(next.content.text, {
                interactive: true,
                language: currentLanguage(),
              }),
            );
          } catch {
            setDocument(undefined);
            setState({ status: 'error', code: 'type' });
            return;
          }
        } else setDocument(undefined);
        setState(next);
      },
    });
    preview.current = controller;
    void controller.load();
    return () => controller.close();
  }, [name, href, identity, currentIdentity]);
  const content = state.status === 'ready' ? state.content : undefined;
  const hasTabs =
    content?.kind === 'html' || content?.kind === 'table' || content?.kind === 'markdown';
  const showSource = hasTabs && tab === 'source';
  return (
    <Dialog
      scrollBody={false}
      title={name}
      onClose={onClose}
      portal
      wide
      className="file-preview-dialog"
      headerActions={
        <a
          className="file-preview-download"
          href={href}
          download
          title={uiText('workspace:filePreviewDownload')}
          onClick={(event) => {
            if (!preview.current?.current()) event.preventDefault();
          }}
        >
          <Download size={17} aria-hidden="true" />
          <span>{uiText('workspace:filePreviewDownload')}</span>
        </a>
      }
    >
      {hasTabs && (
        <div className="file-preview-toolbar">
          <div
            className="file-preview-tabs"
            role="tablist"
            aria-label={uiText('workspace:filePreviewMode')}
            onKeyDown={(event) => {
              const next =
                event.key === 'Home'
                  ? 'preview'
                  : event.key === 'End'
                    ? 'source'
                    : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                      ? tab === 'source'
                        ? 'preview'
                        : 'source'
                      : undefined;
              if (!next || !preview.current?.current()) return;
              event.preventDefault();
              setTab(next);
              const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]');
              tabs[next === 'preview' ? 0 : 1]?.focus();
            }}
          >
            {(['preview', 'source'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`${panelId}-${value}`}
                aria-selected={tab === value}
                aria-controls={panelId}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => {
                  if (preview.current?.current()) setTab(value);
                }}
              >
                {uiText(
                  value === 'preview' ? 'workspace:filePreviewTab' : 'workspace:filePreviewSource',
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        className="file-preview-body"
        id={panelId}
        role={hasTabs ? 'tabpanel' : undefined}
        aria-labelledby={hasTabs ? `${panelId}-${tab}` : undefined}
        aria-busy={state.status === 'loading'}
      >
        {state.status === 'loading' && (
          <p role="status">{uiText('workspace:filePreviewLoading')}</p>
        )}
        {state.status === 'unsupported' && <p>{uiText('workspace:filePreviewUnsupported')}</p>}
        {state.status === 'error' && (
          <div className="file-preview-error" role="alert">
            <p>{uiText(`workspace:filePreviewError_${state.code}`)}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                if (preview.current?.current()) void preview.current.load();
              }}
            >
              <RefreshCw size={15} />
              {uiText('workspace:filePreviewRetry')}
            </button>
          </div>
        )}
        {content?.kind === 'image' && <RasterFilePreview url={content.url} name={name} />}
        {content &&
          (content.kind === 'text' ||
            ((content.kind === 'html' || content.kind === 'table' || content.kind === 'markdown') &&
              showSource)) && (
            <pre className="file-preview-source" tabIndex={0}>
              {content.text}
            </pre>
          )}
        {content &&
          content.kind !== 'text' &&
          content.kind !== 'html' &&
          content.kind !== 'image' &&
          !showSource && <FormattedFilePreview content={content} />}
        {content?.kind === 'html' && document && (
          <iframe
            className="file-preview-html"
            hidden={showSource}
            title={uiText('workspace:filePreviewDocument')}
            sandbox={document.interactive ? 'allow-scripts' : ''}
            referrerPolicy="no-referrer"
            srcDoc={document.html}
          />
        )}
      </div>
      {content?.kind === 'html' && !showSource && (
        <p className="file-preview-note">
          <ShieldCheck size={14} aria-hidden="true" />
          {uiText(
            document?.interactive
              ? 'workspace:filePreviewInteractiveNote'
              : 'workspace:filePreviewStaticNote',
          )}
        </p>
      )}
    </Dialog>
  );
}

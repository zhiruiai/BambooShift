import { useEffect, useMemo, useRef } from 'react';
import { uiText } from '../i18n';
import { websitePreviewDocument, websitePreviewToken } from '../websitePreviewDocument';
import { websiteFiles, type WebsitePreviewFile } from '../websitePreviewFiles';
import './WebsiteProjectPreview.css';

export type { WebsitePreviewFile } from '../websitePreviewFiles';

export function WebsiteProjectPreview({
  files,
  entryPath,
  onNavigate,
}: {
  files: WebsitePreviewFile[];
  entryPath: string;
  onNavigate(path: string): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const scriptError = uiText('workspace:websiteProjectScriptError');
  const partial = uiText('workspace:websiteProjectPartial');
  const preview = useMemo(() => {
    try {
      const index = websiteFiles(files);
      const channel = websitePreviewToken();
      const srcDoc = websitePreviewDocument(index, entryPath, {
        channel,
        scriptError,
        partial,
      });
      return { index, channel, srcDoc };
    } catch {
      return undefined;
    }
  }, [files, entryPath, scriptError, partial]);

  useEffect(() => {
    if (!preview) return;
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (
        event.source === frame.current?.contentWindow &&
        event.origin === 'null' &&
        message?.channel === preview.channel &&
        message?.kind === 'navigate' &&
        typeof message.value === 'string' &&
        preview.index.get(message.value)?.mime === 'text/html'
      )
        onNavigate(message.value);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [preview, onNavigate]);

  return preview ? (
    <iframe
      ref={frame}
      className="website-project-preview"
      title={uiText('workspace:filePreviewDocument')}
      sandbox="allow-scripts allow-pointer-lock"
      referrerPolicy="no-referrer"
      srcDoc={preview.srcDoc}
    />
  ) : (
    <p role="alert">{uiText('workspace:filePreviewError_type')}</p>
  );
}

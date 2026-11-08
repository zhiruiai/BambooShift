import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { parseDelimitedPreview } from '../delimitedFilePreview';
import type { FormattedFilePreviewContent } from '../filePreview';
import { uiText } from '../i18n';
import { Markdown } from './Markdown';
import './FormattedFilePreview.css';
import './MarkdownFilePreview.css';

const Pdf = lazy(() =>
  import('./PdfFilePreview').then(({ PdfFilePreview }) => ({ default: PdfFilePreview })),
);
const Office = lazy(() =>
  import('./OfficeFilePreview').then(({ OfficeFilePreview }) => ({ default: OfficeFilePreview })),
);

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <p role="alert">{uiText('workspace:filePreviewError_type')}</p>
    ) : (
      this.props.children
    );
  }
}

export function DelimitedFilePreview({ text, delimiter }: { text: string; delimiter: ',' | '\t' }) {
  const result = parseDelimitedPreview(text, delimiter);
  if (!result)
    return (
      <>
        <p>{uiText('workspace:filePreviewTableMalformed')}</p>
        <pre className="file-preview-source">{text}</pre>
      </>
    );
  if (!result.rows.length) return <p>{uiText('workspace:filePreviewTableEmpty')}</p>;
  const columns = Math.max(...result.rows.map((row) => row.length));
  return (
    <div className="formatted-file-table">
      {result.truncated && <p>{uiText('workspace:filePreviewTablePartial')}</p>}
      <div className="formatted-file-table-scroll" tabIndex={0}>
        <table aria-label={uiText('workspace:filePreviewTable')}>
          <thead>
            <tr>
              <th scope="col">#</th>
              {Array.from({ length: columns }, (_, index) => (
                <th scope="col" key={index}>
                  {index + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              <tr key={index}>
                <th scope="row">{index + 1}</th>
                {Array.from({ length: columns }, (_, column) => (
                  <td key={column}>{row[column] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MediaPreview({ kind, url }: { kind: 'audio' | 'video'; url: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (url === failedUrl) return <p role="alert">{uiText('workspace:filePreviewMediaFailed')}</p>;
  const props = {
    src: url,
    controls: true,
    preload: 'metadata',
    controlsList: 'nodownload noremoteplayback',
    disableRemotePlayback: true,
    onError: () => setFailedUrl(url),
  };
  return (
    <div className="formatted-file-media">
      {kind === 'audio' ? (
        <audio {...props} aria-label={uiText('workspace:filePreviewAudio')} />
      ) : (
        <video
          {...props}
          aria-label={uiText('workspace:filePreviewVideo')}
          disablePictureInPicture
          playsInline
        />
      )}
    </div>
  );
}

export function RasterFilePreview({ url, name }: { url: string; name: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (url === failedUrl) return <p role="alert">{uiText('workspace:filePreviewError_type')}</p>;
  return (
    <img
      className="file-preview-image"
      src={url}
      alt={name}
      decoding="async"
      onError={() => setFailedUrl(url)}
    />
  );
}

export function FormattedFilePreview({ content }: { content: FormattedFilePreviewContent }) {
  switch (content.kind) {
    case 'markdown':
      return (
        <PreviewBoundary>
          <article className="markdown-file-preview">
            <Markdown text={content.text} passive />
          </article>
        </PreviewBoundary>
      );
    case 'table':
      return <DelimitedFilePreview text={content.text} delimiter={content.delimiter} />;
    case 'audio':
    case 'video':
      return <MediaPreview kind={content.kind} url={content.url} />;
    case 'pdf':
    case 'office':
      return (
        <PreviewBoundary>
          <Suspense fallback={<p role="status">{uiText('workspace:filePreviewLoading')}</p>}>
            {content.kind === 'pdf' ? (
              <Pdf bytes={content.bytes} />
            ) : (
              <Office bytes={content.bytes} format={content.format} />
            )}
          </Suspense>
        </PreviewBoundary>
      );
  }
}

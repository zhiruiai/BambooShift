import { useEffect, useRef, useState } from 'react';
import { uiText } from '../i18n';
import { PdfPreviewError, type PdfPreviewSession } from '../pdfPreviewSession';
import './PdfFilePreview.css';

type PreviewState =
  | { source: Uint8Array; failure: PdfPreviewError['code'] }
  | {
      source: Uint8Array;
      session: PdfPreviewSession;
      total: number;
      page: number;
      painted: boolean;
    };

function failureCode(error: unknown): PdfPreviewError['code'] {
  return error instanceof PdfPreviewError ? error.code : 'type';
}

export function PdfFilePreview({ bytes }: { bytes: Uint8Array }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<PreviewState>();
  const current = state?.source === bytes ? state : undefined;
  const ready = current && 'session' in current ? current : undefined;
  const session = ready?.session;
  const number = ready?.page;

  useEffect(() => {
    let closed = false;
    let active: PdfPreviewSession | undefined;
    void (async () => {
      const { startPdfPreview } = await import('../pdfPreviewRuntime');
      if (closed) return;
      active = startPdfPreview(bytes);
      const total = await active.pageCount;
      if (!closed) setState({ source: bytes, session: active, total, page: 1, painted: false });
    })().catch((error: unknown) => {
      if (!closed) setState({ source: bytes, failure: failureCode(error) });
    });
    return () => {
      closed = true;
      active?.close();
    };
  }, [bytes]);

  useEffect(() => {
    const target = canvas.current;
    if (!session || !target || number === undefined) return;
    const request = new AbortController();
    void session.renderPage(number, target, request.signal).then(
      () => {
        if (request.signal.aborted) return;
        setState((value) =>
          value && 'session' in value && value.session === session && value.page === number
            ? { ...value, painted: true }
            : value,
        );
      },
      (error: unknown) => {
        if (!request.signal.aborted) setState({ source: bytes, failure: failureCode(error) });
      },
    );
    return () => {
      request.abort();
      target.width = target.height = 0;
    };
  }, [bytes, number, session]);

  if (current && 'failure' in current) {
    const message =
      current.failure === 'password'
        ? 'workspace:filePreviewPdfPassword'
        : current.failure === 'limit'
          ? 'workspace:filePreviewPdfLimit'
          : 'workspace:filePreviewError_type';
    return <p role="alert">{uiText(message)}</p>;
  }

  function step(offset: number) {
    setState((value) => {
      if (!value || !('session' in value) || value.session !== session) return value;
      const page = value.page + offset;
      return page > 0 && page <= value.total ? { ...value, page, painted: false } : value;
    });
  }

  const pageLabel = ready
    ? uiText('workspace:filePreviewPdfPage', { page: ready.page, total: ready.total })
    : undefined;
  return (
    <div className="pdf-file-preview" aria-busy={!ready?.painted}>
      {ready && (
        <div className="pdf-file-preview-controls">
          <button
            type="button"
            className="secondary-button"
            disabled={ready.page === 1}
            onClick={() => step(-1)}
          >
            {uiText('workspace:filePreviewPdfPrevious')}
          </button>
          <span aria-live="polite">{pageLabel}</span>
          <button
            type="button"
            className="secondary-button"
            disabled={ready.page === ready.total}
            onClick={() => step(1)}
          >
            {uiText('workspace:filePreviewPdfNext')}
          </button>
        </div>
      )}
      {!ready?.painted && <p role="status">{uiText('workspace:filePreviewLoading')}</p>}
      {ready && (
        <canvas
          ref={canvas}
          width={0}
          height={0}
          hidden={!ready.painted}
          role="img"
          aria-label={pageLabel}
        />
      )}
    </div>
  );
}

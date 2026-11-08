import * as pdfjs from 'pdfjs-dist';
import { openPdfPreview } from './pdfPreviewSession';

export function startPdfPreview(bytes: Uint8Array) {
  return openPdfPreview(
    bytes,
    pdfjs,
    () =>
      new Worker(new URL('./pdfPreviewWorker.ts', import.meta.url), {
        type: 'module',
        name: 'openbot-pdf-preview',
      }),
  );
}

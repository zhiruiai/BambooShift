import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist/types/src/display/api';
import { BINARY_PREVIEW_LIMIT } from './filePreview';

const MAX_PAGES = 200;
const MAX_EDGE = 3072;
const MAX_PIXELS = 4_000_000;
const MAX_SCRATCH_PIXELS = 12_000_000;
const MAX_OPERATIONS = 100_000;
const PREVIEW_TIMEOUT = 10_000;

export class PdfPreviewError extends Error {
  constructor(readonly code: 'type' | 'password' | 'limit') {
    super(code);
  }
}

function canvasPixels(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_EDGE ||
    height > MAX_EDGE ||
    width * height > MAX_PIXELS
  ) {
    throw new PdfPreviewError('type');
  }
  return width * height;
}

export function pdfPageScale(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new PdfPreviewError('type');
  }
  // Leave room for viewport rounding before applying the allocation cap.
  return Math.min(
    1.65,
    (MAX_EDGE - 1) / Math.max(width, height),
    Math.sqrt(3_990_000 / width / height),
  );
}

type CanvasSlot = { canvas: HTMLCanvasElement | null; context: CanvasRenderingContext2D | null };

class PreviewCanvasFactory {
  private total = 0;
  private readonly allocations = new WeakMap<HTMLCanvasElement, number>();

  constructor(private readonly options: { ownerDocument: Document }) {}

  create(width: number, height: number): CanvasSlot {
    const canvas = this.options.ownerDocument.createElement('canvas');
    const slot = { canvas, context: null };
    this.reset(slot, width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      this.destroy(slot);
      throw new PdfPreviewError('type');
    }
    return { canvas, context };
  }

  reset({ canvas }: CanvasSlot, width: number, height: number) {
    if (!canvas) throw new PdfPreviewError('type');
    const pixels = canvasPixels(width, height);
    const total = this.total - (this.allocations.get(canvas) ?? 0) + pixels;
    if (total > MAX_SCRATCH_PIXELS) throw new PdfPreviewError('type');
    this.total = total;
    this.allocations.set(canvas, pixels);
    canvas.width = width;
    canvas.height = height;
  }

  destroy(slot: CanvasSlot) {
    const { canvas } = slot;
    if (!canvas) return;
    this.total -= this.allocations.get(canvas) ?? 0;
    this.allocations.delete(canvas);
    canvas.width = canvas.height = 0;
    slot.canvas = slot.context = null;
  }
}

class OfflinePdfData {
  async fetch(): Promise<never> {
    throw new PdfPreviewError('type');
  }
}

type PdfEngine = Pick<typeof import('pdfjs-dist'), 'getDocument' | 'PDFWorker' | 'AnnotationMode'>;

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      finish();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new PdfPreviewError('type'));
    }, PREVIEW_TIMEOUT);
    signal.addEventListener('abort', aborted, { once: true });
    work.then(
      (result) => {
        finish();
        resolve(result);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

export function openPdfPreview(bytes: Uint8Array, engine: PdfEngine, createPort: () => Worker) {
  if (!bytes.length || bytes.length > BINARY_PREVIEW_LIMIT) throw new PdfPreviewError('type');
  const port = createPort();
  const lifetime = new AbortController();
  let worker: ReturnType<PdfEngine['PDFWorker']['create']> | undefined;
  let task: PDFDocumentLoadingTask;
  try {
    // A real worker port avoids PDF.js falling back to decoding on the UI thread.
    worker = engine.PDFWorker.create({ port, verbosity: 0 });
    task = engine.getDocument({
      data: new Uint8Array(bytes),
      worker,
      verbosity: 0,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      // Optional decoder imports cannot resolve to a network address.
      wasmUrl: 'about:blank/',
      BinaryDataFactory: OfflinePdfData,
      CanvasFactory: PreviewCanvasFactory,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: true,
      maxImageSize: MAX_PIXELS,
    });
  } catch (error) {
    worker?.destroy();
    port.terminate();
    throw error;
  }

  function close(reason?: unknown) {
    if (lifetime.signal.aborted) return;
    lifetime.abort(reason);
    port.removeEventListener('error', workerFailed);
    port.removeEventListener('messageerror', workerFailed);
    let terminated = false;
    const finish = () => {
      clearTimeout(force);
      if (terminated) return;
      terminated = true;
      worker?.destroy();
      port.terminate();
    };
    // Let PDF.js release document state, with a fixed deadline for a stuck worker.
    const force = setTimeout(finish, 100);
    void task.destroy().then(finish, finish);
  }

  function workerFailed() {
    close(new PdfPreviewError('type'));
  }
  port.addEventListener('error', workerFailed);
  port.addEventListener('messageerror', workerFailed);

  const loaded = bounded(task.promise, lifetime.signal)
    .then((document) => {
      if (!Number.isInteger(document.numPages) || document.numPages < 1)
        throw new PdfPreviewError('type');
      if (document.numPages > MAX_PAGES) throw new PdfPreviewError('limit');
      return document;
    })
    .catch((error: unknown) => {
      close();
      if (error instanceof Error && error.name === 'PasswordException')
        throw new PdfPreviewError('password');
      throw error;
    });

  return {
    pageCount: loaded.then((document) => document.numPages),
    async renderPage(number: number, canvas: HTMLCanvasElement, requested: AbortSignal) {
      const signal = AbortSignal.any([lifetime.signal, requested]);
      let task: RenderTask | undefined;
      const cancel = () => task?.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await bounded(
          (async () => {
            const document = await loaded;
            signal.throwIfAborted();
            if (!Number.isInteger(number) || number < 1 || number > document.numPages)
              throw new PdfPreviewError('type');
            const page = await document.getPage(number);
            try {
              signal.throwIfAborted();
              const natural = page.getViewport({ scale: 1 });
              const viewport = page.getViewport({
                scale: pdfPageScale(natural.width, natural.height),
              });
              const width = Math.ceil(viewport.width),
                height = Math.ceil(viewport.height);
              canvasPixels(width, height);
              canvas.width = width;
              canvas.height = height;
              task = page.render({
                canvas,
                viewport,
                annotationMode: engine.AnnotationMode.DISABLE,
                operationsFilter(index) {
                  if (index >= MAX_OPERATIONS) throw new PdfPreviewError('type');
                  return true;
                },
              });
              await task.promise;
            } finally {
              task = undefined;
              page.cleanup();
            }
          })(),
          signal,
        );
      } catch (error) {
        if (!signal.aborted) close();
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
    close,
  };
}

export type PdfPreviewSession = ReturnType<typeof openPdfPreview>;

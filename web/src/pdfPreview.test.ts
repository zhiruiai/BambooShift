import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import type { DocumentInitParameters, RenderParameters } from 'pdfjs-dist/types/src/display/api';
import { pdfFixture } from '../../server/workers/document-worker/fixtures';
import { BINARY_PREVIEW_LIMIT } from './filePreview';
import { openPdfPreview } from './pdfPreviewSession';

type Engine = Parameters<typeof openPdfPreview>[1];

function fixture(getDocument: Engine['getDocument']) {
  let terminated = 0;
  let destroyed = 0;
  const port = Object.assign(new EventTarget(), {
    terminate() {
      terminated++;
    },
  });
  const worker = {
    destroy() {
      destroyed++;
    },
  };
  const engine = {
    AnnotationMode: { DISABLE: 0 },
    PDFWorker: { create: () => worker },
    getDocument,
  } as unknown as Engine;
  return {
    engine,
    port: () => port as unknown as Worker,
    closed: () => [destroyed, terminated],
  };
}

test('a synthetic two-page PDF paints actual page pixels without changing the source bytes', async () => {
  const legacy = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const source = pdfFixture('OpenBot local preview', 2);
  const original = Buffer.from(source);
  let options: DocumentInitParameters | undefined;
  const f = fixture((init) => {
    options = init;
    // Use the Node test engine to render the same byte-only settings into a software canvas.
    return legacy.getDocument({ ...init, worker: undefined });
  });
  const preview = openPdfPreview(source, f.engine, f.port);
  try {
    assert.equal(await preview.pageCount, 2);
    const canvas = createCanvas(1, 1);
    await preview.renderPage(
      2,
      canvas as unknown as HTMLCanvasElement,
      new AbortController().signal,
    );
    assert.ok(canvas.width > 1 && canvas.height > 1);
    assert.ok(canvas.width * canvas.height <= 4_000_000);
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    assert.ok(image.data.some((value, index) => index % 4 === 0 && value < 128));
    assert.deepEqual(source, original);
    assert.equal(options?.url, undefined);
    assert.equal(options?.enableXfa, false);
    assert.equal(options?.useWorkerFetch, false);
    const LocalOnly = options?.BinaryDataFactory as new () => { fetch(): Promise<never> };
    await assert.rejects(new LocalOnly().fetch());
  } finally {
    preview.close();
  }
});

test('only the requested page is read and navigating away cancels its render', async () => {
  const pages: number[] = [];
  let renderStarted!: () => void;
  const rendered = new Promise<void>((resolve) => {
    renderStarted = resolve;
  });
  let cancelPending!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    cancelPending = reject;
  });
  let cleanups = 0;
  let cancellations = 0;
  let annotationMode: number | undefined;
  const f = fixture(
    () =>
      ({
        promise: Promise.resolve({
          numPages: 2,
          async getPage(number: number) {
            pages.push(number);
            return {
              getViewport: ({ scale }: { scale: number }) => ({
                width: 1_000_000 * scale,
                height: 1_000_000 * scale,
              }),
              render(parameters: RenderParameters) {
                annotationMode = parameters.annotationMode;
                renderStarted();
                return {
                  promise: pending,
                  cancel() {
                    cancellations++;
                    cancelPending(new Error('Render cancelled'));
                  },
                };
              },
              cleanup() {
                cleanups++;
              },
            };
          },
        }),
        async destroy() {},
      }) as unknown as ReturnType<Engine['getDocument']>,
  );
  const preview = openPdfPreview(new Uint8Array([1]), f.engine, f.port);
  try {
    assert.equal(await preview.pageCount, 2);
    assert.deepEqual(pages, []);
    const canvas = { width: 0, height: 0 } as HTMLCanvasElement;
    const navigation = new AbortController();
    const operation = preview.renderPage(2, canvas, navigation.signal);
    await rendered;
    assert.deepEqual(pages, [2]);
    assert.equal(annotationMode, f.engine.AnnotationMode.DISABLE);
    assert.ok(canvas.width * canvas.height <= 4_000_000);
    navigation.abort();
    await assert.rejects(operation, { name: 'AbortError' });
    assert.equal(cancellations, 1);
    assert.equal(cleanups, 1);
    assert.deepEqual(f.closed(), [0, 0]);
  } finally {
    preview.close();
    await Promise.resolve();
    assert.deepEqual(f.closed(), [1, 1]);
  }
});

test('byte and page caps and encrypted files fail before a page can render', async () => {
  const never = fixture(() => assert.fail('Oversized data must not reach PDF.js'));
  assert.throws(
    () => openPdfPreview(new Uint8Array(BINARY_PREVIEW_LIMIT + 1), never.engine, never.port),
    { code: 'type' },
  );
  const large = fixture(
    () =>
      ({
        promise: Promise.resolve({ numPages: 201 }),
        async destroy() {},
      }) as ReturnType<Engine['getDocument']>,
  );
  const locked = fixture(
    () =>
      ({
        promise: Promise.reject(Object.assign(new Error(), { name: 'PasswordException' })),
        async destroy() {},
      }) as ReturnType<Engine['getDocument']>,
  );
  for (const [f, code] of [
    [large, 'limit'],
    [locked, 'password'],
  ] as const) {
    const session = openPdfPreview(new Uint8Array([1]), f.engine, f.port);
    await assert.rejects(session.pageCount, { code });
    assert.deepEqual(f.closed(), [1, 1]);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFilePreview,
  BINARY_PREVIEW_LIMIT,
  FILE_PREVIEW_LIMIT,
  filePreviewKind,
  previewFilePath,
  type FilePreviewState,
} from './filePreview';
import { all, harness, deferred } from './testSupport/creationFlowFixture';

const wid = '11111111-1111-4111-8111-111111111111';
const identity = { userId: 'owner-a', workspaceId: wid, pathname: `/w/${wid}` };
const href = `/api/workspaces/${wid}/files/file_1/download`;
const response = (body: BodyInit | null, mime = 'text/plain', extra: Record<string, string> = {}) =>
  new Response(body, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': 'attachment; filename="synthetic.txt"',
      ...extra,
    },
  });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(fetcher: typeof fetch, name = 'report.txt') {
  const states: FilePreviewState[] = [];
  let current = { ...identity };
  const revoked: string[] = [];
  const blobTypes: string[] = [];
  let urlCount = 0;
  const preview = createFilePreview({
    href,
    name,
    identity,
    currentIdentity: () => current,
    onChange: (state) => states.push(state),
    fetch: fetcher,
    objectUrls: {
      createObjectURL: (blob: Blob) => {
        blobTypes.push(blob.type);
        return `blob:synthetic-${++urlCount}`;
      },
      revokeObjectURL: (url) => revoked.push(url),
    },
  });
  return {
    preview,
    states,
    revoked,
    blobTypes,
    setIdentity(value: Partial<typeof identity>) {
      current = { ...current, ...value };
    },
  };
}

test('only exact current-workspace download paths qualify; formats are explicit', () => {
  assert.equal(previewFilePath(href, identity), href);
  for (const path of [
    href + '?x=1',
    href + '#a',
    'https://example.test' + href,
    '/' + href,
    href.replace('file_1', '%2e%2e'),
    href.replace(wid, '22222222-2222-4222-8222-222222222222'),
    '/api/files/file_1/download',
  ])
    assert.equal(previewFilePath(path, identity), undefined, path);
  assert.equal(previewFilePath(href, { ...identity, pathname: '/login' }), undefined);
  assert.equal(previewFilePath(href, { ...identity, userId: undefined }), undefined);
  assert.equal(
    previewFilePath('/api/files/a/download', { pathname: '/' }),
    '/api/files/a/download',
  );
  assert.equal(filePreviewKind('Report.HTML'), 'html');
  assert.equal(filePreviewKind('notes.md'), 'markdown');
  assert.equal(filePreviewKind('notes.MARKDOWN'), 'markdown');
  assert.equal(filePreviewKind('photo.webp'), 'image');
  for (const [name, kind] of [
    ['report.csv', 'table'],
    ['report.TSV', 'table'],
    ['report.pdf', 'pdf'],
    ['report.docx', 'office'],
    ['book.xlsx', 'office'],
    ['slides.pptx', 'office'],
    ['sound.mp3', 'audio'],
    ['clip.webm', 'video'],
    ['code.ts', 'text'],
  ] as const)
    assert.equal(filePreviewKind(name), kind);
  for (const name of ['photo.svg', 'old.doc', 'archive.zip', 'macro.xlsm'])
    assert.equal(filePreviewKind(name), 'unsupported');
});

test('fixed actor, credentials, no-cache and redirect policy accompany the bounded authorized read', async () => {
  const f = fixture(async (path, init) => {
    assert.equal(path, href);
    assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), identity.userId);
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    return response('Synthetic 中文 🐼');
  });
  await f.preview.load();
  assert.deepEqual(f.states.at(-1), {
    status: 'ready',
    content: { kind: 'text', text: 'Synthetic 中文 🐼' },
  });
  f.preview.close();
});

test('historical HTML artifacts stored as plain text still enter the isolated HTML preview', async () => {
  const document = '<!doctype html><html><body><h1>Synthetic learning report</h1></body></html>';
  for (const mime of ['text/plain', 'text/plain; charset=utf-8']) {
    const f = fixture(async () => response(document, mime), 'historical-learning.html');
    await f.preview.load();
    assert.deepEqual(f.states.at(-1), {
      status: 'ready',
      content: { kind: 'html', text: document },
    });
    f.preview.close();
  }
});

test('Markdown artifacts retain their original text and use the fixed scoped attachment read', async () => {
  const text = '# Synthetic report\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n';
  for (const [name, mime] of [
    ['report.md', 'text/markdown; charset=utf-8'],
    ['report.Markdown', 'text/plain'],
    ['report.MD', 'application/octet-stream'],
  ]) {
    const f = fixture(async (path, init) => {
      assert.equal(path, href);
      assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), identity.userId);
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.redirect, 'error');
      return response(text, mime);
    }, name);
    await f.preview.load();
    assert.deepEqual(f.states.at(-1), { status: 'ready', content: { kind: 'markdown', text } });
    f.preview.close();
  }
  for (const value of [
    response('<h1>Synthetic proxy login</h1>', 'text/html'),
    response(new Uint8Array([0, 127, 15]), 'application/octet-stream'),
    response(new Uint8Array([255, 255]), 'text/plain'),
    new Response(text, { headers: { 'Content-Type': 'text/markdown' } }),
  ]) {
    const f = fixture(async () => value, 'report.md');
    await f.preview.load();
    assert.deepEqual(f.states.at(-1), { status: 'error', code: 'type' });
    f.preview.close();
  }
  const huge = fixture(
    async () =>
      response(text, 'text/markdown', { 'Content-Length': String(FILE_PREVIEW_LIMIT + 1) }),
    'report.md',
  );
  await huge.preview.load();
  assert.deepEqual(huge.states.at(-1), { status: 'error', code: 'large' });
  huge.preview.close();
});

test('HTML compatibility does not accept binary MIME types or unregistered proxy responses', async () => {
  for (const value of [
    response('binary', 'application/pdf'),
    new Response('<h1>Proxy login</h1>', { headers: { 'Content-Type': 'text/plain' } }),
  ]) {
    const f = fixture(async () => value, 'historical-learning.html');
    await f.preview.load();
    assert.deepEqual(f.states.at(-1), { status: 'error', code: 'type' });
    f.preview.close();
  }
});

test('403, proxy HTML, missing attachment header and invalid binary text never become document content', async () => {
  for (const [result, code] of [
    [new Response('<html>private error</html>', { status: 403 }), 'access'],
    [response('<html>login</html>', 'text/html'), 'type'],
    [new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), 'type'],
    [response(new Uint8Array([255, 255])), 'type'],
  ] as const) {
    const f = fixture(async () => result);
    await f.preview.load();
    assert.deepEqual(f.states.at(-1), { status: 'error', code });
    assert.equal(
      f.states.some((state) => state.status === 'ready'),
      false,
    );
    f.preview.close();
  }
});

test('oversized declared and streamed bodies stop reads; a false small length cannot bypass the limit', async () => {
  let cancelled = 0;
  for (const declared of [String(FILE_PREVIEW_LIMIT + 1), '1']) {
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array(FILE_PREVIEW_LIMIT));
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const f = fixture(async () => response(stream, 'text/plain', { 'Content-Length': declared }));
    await f.preview.load();
    assert.deepEqual(f.states.at(-1), { status: 'error', code: 'large' });
    assert.equal(chunks, declared === '1' ? 2 : 0);
    f.preview.close();
  }
  assert.equal(cancelled, 2);
});

test('actor or workspace changes discard late fetch and in-flight stream results', async () => {
  const late = deferred<Response>();
  let lateCancelled = false;
  const f = fixture(async () => late.promise);
  const loading = f.preview.load();
  f.setIdentity({ userId: 'member-b' });
  late.resolve(
    response(
      new ReadableStream({
        cancel() {
          lateCancelled = true;
        },
      }),
    ),
  );
  await loading;
  assert.equal(lateCancelled, true);
  assert.deepEqual(f.states, [{ status: 'loading' }]);
  f.preview.close();

  let push!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const streaming = fixture(async () =>
    response(
      new ReadableStream({
        start(controller) {
          push = controller;
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  const running = streaming.preview.load();
  await tick();
  streaming.setIdentity({ workspaceId: 'other-space' });
  push.enqueue(new TextEncoder().encode('OLD_SPACE_PRIVATE'));
  await running;
  assert.equal(cancelled, true);
  assert.deepEqual(streaming.states, [{ status: 'loading' }]);
  streaming.preview.close();
});

test('close aborts; reload wins over an older response; image URLs are revoked once', async () => {
  const first = deferred<Response>();
  let request = 0;
  const signals: AbortSignal[] = [];
  const f = fixture(async (_path, init) => {
    signals.push(init!.signal as AbortSignal);
    return ++request === 1 ? first.promise : response('new');
  });
  const pending = f.preview.load();
  await f.preview.load();
  first.resolve(response('old'));
  await pending;
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(f.states.at(-1), { status: 'ready', content: { kind: 'text', text: 'new' } });
  f.preview.close();
  assert.equal(signals[1].aborted, true);
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/Yo7qh0AAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const image = fixture(async () => response(png, 'image/png'), 'image.png');
  await image.preview.load();
  await image.preview.load();
  image.preview.close();
  image.preview.close();
  assert.deepEqual(image.revoked, ['blob:synthetic-1', 'blob:synthetic-2']);
});

test('image type spoofing is rejected; unsupported files do not fetch', async () => {
  const image = fixture(async () => response('<svg onload="unsafe()"/>', 'image/png'), 'image.png');
  await image.preview.load();
  assert.deepEqual(image.states.at(-1), { status: 'error', code: 'type' });
  image.preview.close();
  const archive = fixture(async () => {
    throw Error('Unsupported formats should not fetch');
  }, 'report.zip');
  await archive.preview.load();
  assert.deepEqual(archive.states, [{ status: 'unsupported' }]);
  archive.preview.close();
});

test('PDF and Office receive bounded bytes with format verification on the same download path', async () => {
  const pdfBytes = new Uint8Array(FILE_PREVIEW_LIMIT + 1);
  pdfBytes.set(new TextEncoder().encode('%PDF-1.7'));
  const pdf = fixture(async (path, init) => {
    assert.equal(path, href);
    assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), identity.userId);
    return response(pdfBytes, 'application/octet-stream');
  }, 'report.pdf');
  await pdf.preview.load();
  assert.deepEqual(pdf.states.at(-1), {
    status: 'ready',
    content: { kind: 'pdf', bytes: pdfBytes },
  });
  const officeBytes = new Uint8Array([80, 75, 3, 4]);
  const office = fixture(async () => response(officeBytes, 'application/zip'), 'slides.pptx');
  await office.preview.load();
  assert.deepEqual(office.states.at(-1), {
    status: 'ready',
    content: { kind: 'office', format: 'pptx', bytes: officeBytes },
  });
  const spoof = fixture(async () => response('<svg/>', 'application/pdf'), 'fake.pdf');
  await spoof.preview.load();
  assert.deepEqual(spoof.states.at(-1), { status: 'error', code: 'type' });
  const huge = fixture(
    async () =>
      response(pdfBytes, 'application/pdf', { 'Content-Length': String(BINARY_PREVIEW_LIMIT + 1) }),
    'huge.pdf',
  );
  await huge.preview.load();
  assert.deepEqual(huge.states.at(-1), { status: 'error', code: 'large' });
  for (const f of [pdf, office, spoof, huge]) f.preview.close();
});

test('tables keep their original source and media only uses validated local blob URLs', async () => {
  const table = fixture(
    async () => response('Name\tValue', 'text/tab-separated-values'),
    'rows.tsv',
  );
  await table.preview.load();
  assert.deepEqual(table.states.at(-1), {
    status: 'ready',
    content: { kind: 'table', text: 'Name\tValue', delimiter: '\t' },
  });
  const wav = fixture(async () => response('RIFF0000WAVEfmt ', 'audio/x-wav'), 'note.wav');
  await wav.preview.load();
  assert.deepEqual(wav.states.at(-1), {
    status: 'ready',
    content: { kind: 'audio', url: 'blob:synthetic-1' },
  });
  assert.deepEqual(wav.blobTypes, ['audio/wav']);
  const mp4 = fixture(
    async () =>
      response(
        new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]),
        'video/mp4',
      ),
    'clip.mp4',
  );
  await mp4.preview.load();
  assert.deepEqual(mp4.states.at(-1), {
    status: 'ready',
    content: { kind: 'video', url: 'blob:synthetic-1' },
  });
  assert.deepEqual(mp4.blobTypes, ['video/mp4']);
  const invalid = fixture(async () => response('<script/>', 'video/mp4'), 'spoof.mp4');
  await invalid.preview.load();
  assert.deepEqual(invalid.states.at(-1), { status: 'error', code: 'type' });
  assert.deepEqual(invalid.blobTypes, []);
  for (const f of [table, wav, mp4, invalid]) f.preview.close();
  assert.deepEqual(wav.revoked, ['blob:synthetic-1']);
  assert.deepEqual(mp4.revoked, ['blob:synthetic-1']);
});

test('FileCard keeps a separate download action and invalidates its open dialog and old handlers on account change', async () => {
  const window = { location: { pathname: identity.pathname } };
  const ui = await harness(
    'web/src/components/FileCard.tsx',
    'FileCardContent',
    { name: 'report.txt', size: 5, href, identity },
    { window },
  );
  await ui.flush();
  const button = all(ui.tree, (node) => node.props.className === 'file-card-open')[0];
  const download = all(ui.tree, (node) => node.type === 'a')[0];
  assert.equal(download.props.href, href);
  assert.equal(download.props.download, true);
  button.props.onClick();
  await ui.flush();
  assert.equal(all(ui.tree, (node) => node.type?.name === 'FilePreviewDialog').length, 1);
  ui.setProps({ identity: { ...identity, userId: 'member-b' } });
  await ui.flush();
  assert.equal(all(ui.tree, (node) => node.type?.name === 'FilePreviewDialog').length, 0);
  button.props.onClick();
  let blocked = false;
  download.props.onClick({
    preventDefault() {
      blocked = true;
    },
  });
  await ui.flush();
  assert.equal(blocked, true);
  assert.equal(all(ui.tree, (node) => node.type?.name === 'FilePreviewDialog').length, 0);
  ui.setProps({ identity });
  await ui.flush();
  button.props.onClick();
  await ui.flush();
  assert.equal(all(ui.tree, (node) => node.type?.name === 'FilePreviewDialog').length, 0);
  ui.dispose();
});

test('Markdown dialog recovers from a failed read, defaults to rendered, and switches to escaped source', async () => {
  let requests = 0;
  let signal: AbortSignal | undefined;
  const ui = await harness(
    'web/src/components/FilePreviewDialog.tsx',
    'FilePreviewDialog',
    {
      name: 'note.md',
      href,
      identity,
      currentIdentity: () => identity,
      onClose() {},
    },
    {
      TextDecoder,
      TextEncoder,
      Blob,
      fetch: async (_path: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return ++requests === 1
          ? new Response('NO_PRIVATE_ERROR', { status: 403 })
          : response('# Note\n<script>inert</script>');
      },
    },
  );
  await ui.flush();
  assert.equal(ui.copy.includes('NO_PRIVATE_ERROR'), false);
  ui.button('重新加载').props.onClick();
  await ui.flush();
  const tabs = () => all(ui.tree, (node) => node.props?.role === 'tab');
  const source = () => all(ui.tree, (node) => node.type === 'pre');
  const formatted = () => all(ui.tree, (node) => node.type?.name === 'FormattedFilePreview');
  assert.equal(tabs()[0].props['aria-selected'], true);
  assert.equal(tabs()[1].props['aria-selected'], false);
  assert.equal(formatted()[0].props.content.kind, 'markdown');
  assert.equal(source().length, 0);
  tabs()[1].props.onClick();
  await ui.flush();
  assert.equal(source()[0].props.children, '# Note\n<script>inert</script>');
  assert.equal(formatted().length, 0);
  assert.equal(all(ui.tree, (node) => node.props?.dangerouslySetInnerHTML).length, 0);
  tabs()[0].props.onClick();
  await ui.flush();
  assert.equal(formatted().length, 1);
  assert.equal(source().length, 0);
  ui.dispose();
  assert.equal(signal?.aborted, true);
});

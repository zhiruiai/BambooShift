import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { websitePreviewCsp } from './websitePreviewDocument';
import {
  websiteAssetResolver,
  websiteFiles,
  websitePage,
  websiteRelativePath,
  websiteScripts,
  websiteStyles,
} from './websitePreviewFiles';
import { WEBSITE_FRAME_RUNTIME, WEBSITE_WORKER_RUNTIME } from './websitePreviewRuntime';

function file(path: string, mime: string, content: string) {
  return { path, mime, bytes: new TextEncoder().encode(content) };
}

test('website preview resolves relative paths from a single exact manifest and never resolves external URLs', () => {
  const files = websiteFiles([
    file('pages/about.html', 'text/html', ''),
    file('help/index.html', 'text/html', ''),
    file('index.html', 'text/html', ''),
  ]);
  assert.equal(websitePage(files, 'pages/about.html', '../help/'), 'help/index.html');
  assert.equal(websitePage(files, 'pages/about.html', '/'), 'index.html');
  assert.equal(
    websitePage(files, 'pages/about.html', './about.html?mode=preview'),
    'pages/about.html',
  );
  for (const value of [
    '../../outside.html',
    '//example.test/path',
    'https://example.test/',
    'blob:x',
    '%2e%2e/index.html',
    '..\\index.html',
  ])
    assert.equal(websiteRelativePath('pages/about.html', value), undefined);
  assert.throws(() =>
    websiteFiles([file('a.html', 'text/html', ''), file('A.html', 'text/html', '')]),
  );
});

test('local styles and images resolve against their owning directory without external CSS or links', () => {
  const files = websiteFiles([
    file('css/colors.css', 'text/css', '.card { background: url(../img/icon.svg); }'),
    file('img/icon.svg', 'image/svg+xml', '<svg/>'),
  ]);
  const css = websiteStyles(
    '@import "./colors.css"; @import "https://example.test/external.css"; .hero { background: url("https://example.test/image.png"); }',
    'css/main.css',
    files,
    websiteAssetResolver(files),
  );
  assert.match(css, /\.card.*url\("data:image\/svg\+xml;base64,/);
  assert.match(css, /\.hero.*background: none/);
  assert.doesNotMatch(css, /example\.test|@import/);
  const csp = websitePreviewCsp('a'.repeat(32));
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|https?:/);
});

test('literal local module imports are paired with a manifest entry and unavailable code is skipped', () => {
  const files = websiteFiles([
    file('src/math.mjs', 'text/javascript', 'export const result = 8'),
    file(
      'src/main.mjs',
      'text/javascript',
      'import { result } from "./math.mjs"; document.getElementById("result").textContent = result;',
    ),
    file('src/fail.mjs', 'text/javascript', 'import "https://example.test/cdn.js"'),
  ]);
  const graph = websiteScripts(files);
  const node = (src: string) =>
    ({
      getAttribute: (name: string) => (name === 'type' ? 'module' : name === 'src' ? src : null),
    }) as unknown as Element;
  graph.addEntry(node('src/main.mjs'), 'index.html');
  graph.addEntry(node('src/fail.mjs'), 'index.html');
  assert.deepEqual(graph.entries, [0]);
  assert.equal(graph.scripts.length, 2);
  const entry = graph.scripts[0];
  const [dependency] = entry.imports;
  assert.equal(entry.code.slice(dependency.from, dependency.to), './math.mjs');
  assert.equal(graph.scripts[dependency.index].code, 'export const result = 8');
  assert.equal(graph.skipped, true);
});

test('worker runs local classic code against bounded handles without network or browser APIs', async () => {
  const messages: unknown[] = [];
  const listeners = new Map<string, Set<(event: { data: unknown }) => void | Promise<void>>>();
  const forbidden = () => assert.fail('Project script reached a network primitive');
  const scope: Record<string, unknown> = {
    fetch: forbidden,
    WebSocket: forbidden,
    RTCPeerConnection: forbidden,
    Worker: forbidden,
    EventTarget,
    Event,
    postMessage: (message: unknown) => messages.push(message),
    dispatchEvent() {},
    addEventListener(type: string, listener: (event: { data: unknown }) => void | Promise<void>) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(
      type: string,
      listener: (event: { data: unknown }) => void | Promise<void>,
    ) {
      listeners.get(type)?.delete(listener);
    },
    importScripts() {
      runInContext(
        'if (fetch || WebSocket || RTCPeerConnection || Worker || importScripts || window !== self) throw Error();' +
          'document.getElementById("status").textContent = "Local update";',
        context,
      );
    },
  };
  scope.self = scope;
  const context = createContext(scope);
  runInContext(WEBSITE_WORKER_RUNTIME, context);
  const init = [...listeners.get('message')!][0];
  await init({
    data: {
      kind: 'init',
      elements: [{ key: '1', tag: 'p', id: 'status', classes: [], data: {}, text: '', value: '' }],
      entries: [{ url: 'blob:null/synthetic', module: false }],
      width: 960,
      height: 540,
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { kind: 'op', op: 'text', id: '1', value: 'Local update' },
    { kind: 'ready' },
  ]);
  assert.doesNotThrow(() => new Function(WEBSITE_FRAME_RUNTIME));
});

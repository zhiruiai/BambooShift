import { copyPreviewSvg, SVG_NAMESPACE } from './htmlPreviewSvg';
import {
  websiteAssetResolver,
  websitePage,
  websiteRelativePath,
  websiteScripts,
  websiteStyles,
  websiteText,
  type WebsitePreviewFile,
} from './websitePreviewFiles';
import { WEBSITE_FRAME_RUNTIME, WEBSITE_WORKER_RUNTIME } from './websitePreviewRuntime';

const tags = new Set(
  (
    'article section header footer main aside nav div span p h1 h2 h3 h4 h5 h6 ' +
    'table caption colgroup col thead tbody tfoot tr th td ul ol li dl dt dd pre code blockquote ' +
    'figure figcaption br hr b strong i em u s del ins small sup sub mark time abbr address ' +
    'details summary button a canvas img input label meter progress'
  ).split(' '),
);
const discarded = new Set(
  'iframe frame frameset object embed math meta base title noscript template audio video source track'.split(
    ' ',
  ),
);
const attributes = new Set(
  'class id title lang dir colspan rowspan span start reversed alt width height hidden open tabindex role'.split(
    ' ',
  ),
);
const inputTypes = new Set(['button', 'checkbox', 'radio', 'range', 'number', 'text', 'color']);

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BASELINE =
  'html{font-size:14px}body{min-width:0}small,sub,sup{font-size:12px!important}' +
  'img,canvas,svg{max-width:100%}canvas[hidden]{display:none!important}' +
  '[data-ob-project-link]{cursor:pointer;text-decoration:underline;color:LinkText}' +
  '#ob-project-status{font:14px/1.5 system-ui,sans-serif;padding:12px}' +
  '#ob-project-status:empty{display:none}';

export function websitePreviewCsp(nonce: string) {
  if (!/^[a-f0-9]{32}$/i.test(nonce)) throw Error('Invalid website preview nonce.');
  return (
    `default-src 'none'; script-src 'nonce-${nonce}' blob:; script-src-attr 'none'; ` +
    "style-src 'unsafe-inline'; img-src data:; font-src data:; worker-src blob:; " +
    "connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; " +
    "base-uri 'none'; form-action 'none'; manifest-src 'none'; webrtc 'block'"
  );
}

export function websitePreviewToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function websitePreviewDocument(
  files: Map<string, WebsitePreviewFile>,
  entryPath: string,
  options: { channel: string; scriptError: string; partial: string },
) {
  const entry = files.get(entryPath);
  if (!entry || entry.mime !== 'text/html') throw Error('Invalid website preview entry.');
  const source = websiteText(entry);
  const parsed = document.createElement('template');
  parsed.innerHTML = source;
  const output = new DOMParser().parseFromString(
    '<!doctype html><html><head></head><body></body></html>',
    'text/html',
  );
  const nonce = websitePreviewToken();
  const meta = (name: string, value: string) => {
    const element = output.createElement('meta');
    element.httpEquiv = name;
    element.content = value;
    output.head.append(element);
  };
  meta('Content-Security-Policy', websitePreviewCsp(nonce));
  meta('X-DNS-Prefetch-Control', 'off');
  const charset = output.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  output.head.append(charset);
  const baseline = output.createElement('style');
  baseline.textContent = BASELINE;
  output.head.append(baseline);

  const assets = websiteAssetResolver(files);
  const scripts = websiteScripts(files);
  const styleBudget = { bytes: 0, imports: 0 };
  let partial = false;
  let count = 0;
  let nodes = 0;
  let canvas: Element | undefined;

  function styles(text: string, path: string) {
    const style = output.createElement('style');
    // Avoid closing a raw-text style element during srcdoc serialization.
    style.textContent = websiteStyles(text, path, files, assets, undefined, styleBudget).replaceAll(
      '<',
      '\\3c ',
    );
    output.head.append(style);
  }

  function copyAttributes(node: Element, element: Element) {
    for (const { name, value } of Array.from(node.attributes).slice(0, 50)) {
      if (
        value.length > 1024 ||
        name.startsWith('data-ob-project') ||
        value.startsWith('ob-project-')
      )
        continue;
      if (attributes.has(name) || /^(?:data|aria)-[a-z0-9_-]{1,50}$/.test(name)) {
        element.setAttribute(name, value);
      }
    }
    const inline = node.getAttribute('style');
    if (inline)
      element.setAttribute(
        'style',
        websiteStyles(inline, entryPath, files, assets, undefined, styleBudget),
      );
  }

  // Template parsing strips the outer html/body wrappers. Keep their safe styling attributes.
  for (const tag of ['html', 'body'] as const) {
    const match = new RegExp(`<${tag}(?=\\s|>)([^>]*)>`, 'i').exec(source);
    if (!match) continue;
    const wrapper = document.createElement('template');
    wrapper.innerHTML = `<div${match[1]}></div>`;
    const original = wrapper.content.firstElementChild;
    if (original) copyAttributes(original, tag === 'html' ? output.documentElement : output.body);
  }

  function copy(node: Node, parent: Node, depth: number) {
    if (++count > 20000 || depth > 100) throw Error('Website preview exceeds its element limit.');
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(output.createTextNode(node.textContent || ''));
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.localName.toLowerCase();
    const svg = node.namespaceURI === SVG_NAMESPACE;
    if ((!svg && node.namespaceURI !== HTML_NAMESPACE) || discarded.has(tag)) return;
    if (!svg && tag === 'script') {
      scripts.addEntry(node, entryPath);
      return;
    }
    if (!svg && tag === 'style') {
      styles(node.textContent ?? '', entryPath);
      return;
    }
    if (!svg && tag === 'link') {
      if (node.getAttribute('rel')?.toLowerCase() !== 'stylesheet') return;
      const path = websiteRelativePath(entryPath, node.getAttribute('href') ?? '');
      const stylesheet = path === undefined ? undefined : files.get(path);
      if (stylesheet?.mime === 'text/css') styles(websiteText(stylesheet), stylesheet.path);
      else partial = true;
      return;
    }
    const element = svg
      ? copyPreviewSvg(node, output)
      : tags.has(tag)
        ? output.createElement(tag)
        : undefined;
    if (svg && !element) return;
    if (element && !svg) {
      copyAttributes(node, element);
      if (tag === 'img') {
        const url = assets(entryPath, node.getAttribute('src') ?? '', 'image');
        if (url) element.setAttribute('src', url);
        else partial = true;
      }
      if (tag === 'a') {
        const href = node.getAttribute('href')?.trim() ?? '';
        const fragment = /^#[a-z0-9_-]{1,160}$/i.test(href) ? href : undefined;
        const target = fragment ?? websitePage(files, entryPath, href);
        if (target) {
          element.setAttribute('data-ob-project-link', target);
          element.setAttribute('role', 'link');
          element.setAttribute('tabindex', '0');
        }
      }
      if (tag === 'button') element.setAttribute('type', 'button');
      if (tag === 'input') {
        const type = node.getAttribute('type')?.toLowerCase() ?? 'text';
        element.setAttribute('type', inputTypes.has(type) ? type : 'text');
        for (const name of ['value', 'min', 'max', 'step', 'placeholder', 'checked']) {
          const value = node.getAttribute(name);
          if (value !== null && value.length <= 1000) element.setAttribute(name, value);
        }
      }
      if (tag === 'canvas') {
        if (canvas) return;
        canvas = element;
        canvas.setAttribute('data-ob-project-canvas', '');
      }
      if (
        nodes < 300 &&
        (element.id || element.classList.length || ['button', 'input', 'canvas'].includes(tag))
      ) {
        element.setAttribute('data-ob-project-node', String(++nodes));
      }
    }
    if (element) parent.appendChild(element);
    for (const child of Array.from(node.childNodes)) copy(child, element || parent, depth + 1);
  }

  for (const child of Array.from(parsed.content.childNodes)) copy(child, output.body, 0);
  if (!canvas && scripts.entries.length) {
    canvas = output.createElement('canvas');
    canvas.setAttribute('data-ob-project-canvas', '');
    canvas.setAttribute('hidden', '');
    output.body.append(canvas);
  }
  const status = output.createElement('p');
  status.id = 'ob-project-status';
  status.setAttribute('role', 'status');
  status.textContent = partial || scripts.skipped ? options.partial : '';
  output.body.append(status);

  const payload = output.createElement('script');
  payload.id = 'ob-project-data';
  payload.type = 'application/json';
  payload.textContent = JSON.stringify({
    channel: options.channel,
    scriptError: options.scriptError,
    entries: scripts.entries,
    scripts: scripts.scripts,
    runtime: WEBSITE_WORKER_RUNTIME,
  }).replaceAll('<', '\\u003c');
  output.body.append(payload);
  const script = output.createElement('script');
  script.setAttribute('nonce', nonce);
  script.textContent = WEBSITE_FRAME_RUNTIME;
  output.body.append(script);
  return '<!doctype html>\n' + output.documentElement.outerHTML;
}

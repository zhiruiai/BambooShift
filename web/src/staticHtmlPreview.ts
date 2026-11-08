import { bindPreviewAction, previewAction } from './htmlPreviewActions';
import { HTML_PREVIEW_RUNTIME } from './htmlPreviewRuntime';
import { safeDeclarations, safeStyles } from './htmlPreviewStyles';
import { copyPreviewSvg, SVG_NAMESPACE } from './htmlPreviewSvg';

const tags = new Set(
  (
    'article section header footer main aside nav div span p h1 h2 h3 h4 h5 h6 ' +
    'table caption colgroup col thead tbody tfoot tr th td ul ol li dl dt dd pre code blockquote ' +
    'figure figcaption br hr b strong i em u s del ins small sup sub mark time abbr address details summary button'
  ).split(' '),
);
const discarded = new Set(
  (
    'script iframe frame frameset object embed math link meta base title form ' +
    'input select textarea option video audio source track canvas noscript template'
  ).split(' '),
);
const attributes = new Set([
  'class',
  'id',
  'title',
  'lang',
  'dir',
  'colspan',
  'rowspan',
  'span',
  'start',
  'reversed',
]);
export const STATIC_HTML_CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; " +
  "style-src 'unsafe-inline'; font-src data:; object-src 'none'; frame-src 'none'; media-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

export function renderHtmlPreview(
  source: string,
  options: { interactive?: boolean; language?: string } = {},
) {
  // Template contents stay inert, including resource-bearing elements, during parsing.
  const parsed = document.createElement('template');
  parsed.innerHTML = source;
  const output = new DOMParser().parseFromString(
    '<!doctype html><html><head></head><body></body></html>',
    'text/html',
  );
  const policy = output.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  const nonce = options.interactive ? crypto.randomUUID().replaceAll('-', '') : undefined;
  policy.content = STATIC_HTML_CSP;
  output.head.append(policy);
  const charset = output.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  output.head.append(charset);
  let count = 0;
  const copy = (node: Node, target: Node, depth = 0) => {
    if (++count > 20000 || depth > 100) return;
    if (node.nodeType === Node.TEXT_NODE) {
      target.appendChild(output.createTextNode(node.textContent || ''));
      return;
    }
    if (!(node instanceof Element)) return;
    const name = node.localName.toLowerCase();
    const svg = node.namespaceURI === SVG_NAMESPACE;
    if ((!svg && node.namespaceURI !== 'http://www.w3.org/1999/xhtml') || discarded.has(name))
      return;
    if (name === 'style') {
      const style = output.createElement('style');
      // A style raw-text element must remain closed only by our serializer.
      style.textContent = safeStyles(node.textContent || '').replaceAll('<', '\\3c ');
      output.head.append(style);
      return;
    }
    if (name === 'img') {
      const src = node.getAttribute('src') || '';
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(src)) return;
      const image = output.createElement('img');
      image.src = src;
      image.alt = node.getAttribute('alt') || '';
      image.style.maxWidth = '100%';
      target.appendChild(image);
      return;
    }
    const element = svg
      ? copyPreviewSvg(node, output)
      : tags.has(name)
        ? output.createElement(name)
        : undefined;
    if (svg && !element) return;
    if (element) {
      for (const attr of Array.from(node.attributes)) {
        if (attributes.has(attr.name) && attr.value.length <= 1024)
          element.setAttribute(attr.name, attr.value);
      }
      const inline = document.createElement('span');
      inline.style.cssText = node.getAttribute('style') || '';
      const cleanStyle = safeDeclarations(inline.style);
      if (cleanStyle) element.setAttribute('style', cleanStyle);
      if (name === 'details' && node.hasAttribute('open')) element.setAttribute('open', '');
      if (name === 'button') {
        element.setAttribute('type', 'button');
        element.setAttribute('disabled', '');
      }
      if (nonce) {
        const answer = node.getAttribute('data-ans');
        if (!svg && node.classList.contains('question') && answer && answer.length <= 16)
          element.setAttribute('data-ob-answer', answer);
        const action = previewAction(node.getAttribute('onclick') || '');
        if (action && (!svg || action.kind === 'info')) {
          bindPreviewAction(element, action);
          if (name === 'button') element.removeAttribute('disabled');
        }
      }
      target.appendChild(element);
    }
    for (const child of Array.from(node.childNodes)) copy(child, element || target, depth + 1);
  };
  for (const child of Array.from(parsed.content.childNodes)) copy(child, output.body);
  for (const button of output.querySelectorAll('[data-ob-action="section"]')) {
    const [id] = JSON.parse(button.getAttribute('data-ob-args')!);
    const panel = output.getElementById(id);
    if (panel && panel !== button && !panel.contains(button) && !button.contains(panel)) {
      panel.setAttribute('data-ob-panel', '');
    } else {
      button.removeAttribute('data-ob-action');
      button.removeAttribute('data-ob-args');
      if (button.localName === 'button') button.setAttribute('disabled', '');
    }
  }
  const interactive = !!nonce && !!output.querySelector('[data-ob-action]');
  if (interactive) {
    output.documentElement.lang = options.language?.startsWith('zh') ? 'zh' : 'en';
    policy.content = STATIC_HTML_CSP.replace("script-src 'none'", `script-src 'nonce-${nonce}'`);
    const status = output.createElement('p');
    status.setAttribute('data-ob-status', '');
    status.setAttribute('role', 'status');
    output.body.append(status);
    const script = output.createElement('script');
    script.setAttribute('nonce', nonce!);
    script.textContent = HTML_PREVIEW_RUNTIME;
    output.body.append(script);
  }
  const baseline = output.createElement('style');
  baseline.textContent =
    'html{font-size:14px}body{margin:20px;line-height:1.6;overflow-wrap:anywhere}' +
    'small,sub,sup{font-size:12px!important}img,svg{max-width:100%}pre{white-space:pre-wrap}' +
    '[data-ob-panel][hidden],.card-detail[hidden]{display:none!important}' +
    '[data-ob-action]:focus-visible{outline:2px solid currentColor;outline-offset:3px}' +
    '[data-ob-status]:empty{display:none}' +
    '@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}';
  output.head.append(baseline);
  return { html: '<!doctype html>\n' + output.documentElement.outerHTML, interactive };
}

export function staticHtmlPreview(source: string): string {
  return renderHtmlPreview(source).html;
}

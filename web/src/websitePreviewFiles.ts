export type WebsitePreviewFile = { path: string; mime: string; bytes: Uint8Array };

const MAX_PROJECT_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_REFERENCES = 128;
const HTML = 'text/html';
const CSS = 'text/css';
const JS = 'text/javascript';

export const websiteText = (file: WebsitePreviewFile) =>
  new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);

export function websiteFiles(files: WebsitePreviewFile[]) {
  if (files.length < 1 || files.length > 64) throw Error('Invalid website preview file count.');
  const index = new Map<string, WebsitePreviewFile>();
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (
      file.path.length > 240 ||
      file.path.split('/').length > 12 ||
      !file.path.split('/').every((part) => /^[a-z0-9_-][a-z0-9._-]{0,79}$/i.test(part)) ||
      names.has(key) ||
      file.bytes.byteLength > MAX_FILE_BYTES
    )
      throw Error('Invalid website preview file.');
    names.add(key);
    total += file.bytes.byteLength;
    if (total > MAX_PROJECT_BYTES) throw Error('Website preview exceeds its byte limit.');
    index.set(file.path, file);
  }
  return index;
}

export function websiteRelativePath(from: string, reference: string): string | undefined {
  const raw = reference.trim().split(/[?#]/, 1)[0];
  if (!raw || raw.length > 480 || /^\/\/|[\\:%\s]/.test(raw)) return;
  const parts = raw.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return;
      parts.pop();
    } else if (/^[a-z0-9_-][a-z0-9._-]{0,79}$/i.test(part)) {
      parts.push(part);
    } else return;
  }
  return parts.join('/');
}

export function websitePage(index: Map<string, WebsitePreviewFile>, from: string, href: string) {
  const path = websiteRelativePath(from, href);
  if (path === undefined) return;
  const target = [path, path ? `${path}/index.html` : 'index.html'].find(
    (candidate) => index.get(candidate)?.mime === HTML,
  );
  return target;
}

function base64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

const imageMimes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/svg+xml',
]);
const fontMimes = new Set(['font/woff', 'font/woff2']);

export function websiteAssetResolver(index: Map<string, WebsitePreviewFile>) {
  const cache = new Map<string, string>();
  let references = 0;
  let bytes = 0;
  return (from: string, reference: string, kind: 'image' | 'style'): string | undefined => {
    const path = websiteRelativePath(from, reference);
    const file = path === undefined ? undefined : index.get(path);
    if (!file || !(imageMimes.has(file.mime) || (kind === 'style' && fontMimes.has(file.mime))))
      return;
    if (
      ++references > MAX_ASSET_REFERENCES ||
      (bytes += file.bytes.byteLength) > MAX_PROJECT_BYTES
    ) {
      throw Error('Website preview exceeds its embedded asset limit.');
    }
    const old = cache.get(file.path);
    if (old) return old;
    // A data image stays usable inside an opaque frame without inheriting the app origin.
    const url = `data:${file.mime};base64,${base64(file.bytes)}`;
    cache.set(file.path, url);
    return url;
  };
}

type AssetResolver = ReturnType<typeof websiteAssetResolver>;

export function websiteStyles(
  source: string,
  from: string,
  index: Map<string, WebsitePreviewFile>,
  asset: AssetResolver,
  seen = new Set<string>(),
  budget = { bytes: 0, imports: 0 },
): string {
  budget.bytes += source.length;
  if (budget.bytes > MAX_PROJECT_BYTES || ++budget.imports > 512)
    throw Error('Website preview exceeds its stylesheet limit.');
  // Keep only local, simple imports and rewrite all ordinary URL tokens to in-memory assets.
  const imports: string[] = [];
  let result = source.replace(/\/\*[\s\S]*?\*\//g, '');
  result = result.replace(
    /@import\s+(?:url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)'";]+))\s*\)|"([^"\n]*)"|'([^'\n]*)')\s*([^;{}]*);/gi,
    (_match, a, b, c, d, e, media: string) => {
      const path = websiteRelativePath(from, a ?? b ?? c ?? d ?? e ?? '');
      const file = path === undefined ? undefined : index.get(path);
      if (!file || file.mime !== CSS || seen.has(file.path) || seen.size >= 8) return '';
      const imported = websiteStyles(
        websiteText(file),
        file.path,
        index,
        asset,
        new Set([...seen, file.path]),
        budget,
      );
      // The imported text has already resolved its URLs. Protect it from the second pass.
      const marker = `\u0000${imports.push(media.trim() ? `@media ${media.trim()}{${imported}}` : imported) - 1}\u0000`;
      return marker;
    },
  );
  result = result.replace(
    /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)'";]+))\s*\)/gi,
    (_match, quoted, single, plain) => {
      const value = asset(from, quoted ?? single ?? plain ?? '', 'style');
      return value ? `url("${value}")` : 'none';
    },
  );
  return result.replace(/\u0000(\d+)\u0000/g, (_match, id) => imports[Number(id)] ?? '');
}

export type WebsitePreviewScript = {
  code: string;
  module: boolean;
  imports: Array<{ from: number; to: number; index: number }>;
};

export function websiteScripts(index: Map<string, WebsitePreviewFile>) {
  const scripts: WebsitePreviewScript[] = [];
  const entries: number[] = [];
  const modules = new Map<string, number>();
  let bytes = 0;
  let skipped = false;

  function add(code: string, path: string, module: boolean, active: Set<string>): number {
    if (scripts.length >= 64 || (bytes += code.length) > MAX_PROJECT_BYTES)
      throw Error('Website script limit exceeded.');
    const script: WebsitePreviewScript = { code, module, imports: [] };
    const id = scripts.push(script) - 1;
    if (!module) return id;
    // Only literal module paths in a finite acyclic local graph are rewritten.
    const pattern =
      /\b(?:import\s*\(\s*|import\s*(?:[^;"'()]*?\bfrom\s*)?|export\b[^;"'()]*?\bfrom\s*)(["'])([^"'\r\n]+)\1/g;
    for (const match of code.matchAll(pattern)) {
      const reference = match[2];
      const target = /^\.{1,2}\//.test(reference)
        ? websiteRelativePath(path, reference)
        : undefined;
      const file = target === undefined ? undefined : index.get(target);
      if (!file || file.mime !== JS || active.has(file.path))
        throw Error('Unsupported module dependency.');
      let indexOf = modules.get(file.path);
      if (indexOf === undefined) {
        indexOf = add(websiteText(file), file.path, true, new Set([...active, file.path]));
        modules.set(file.path, indexOf);
      }
      const from = match.index! + match[0].length - reference.length - 1;
      script.imports.push({ from, to: from + reference.length, index: indexOf });
    }
    return id;
  }

  return {
    addEntry(node: Element, from: string) {
      const type = (node.getAttribute('type') ?? '').trim().toLowerCase();
      const module = type === 'module';
      if (type && !module && type !== JS && type !== 'application/javascript') return;
      const start = scripts.length;
      try {
        const src = node.getAttribute('src');
        const path = src === null ? undefined : websiteRelativePath(from, src);
        const file = path === undefined ? undefined : index.get(path);
        if (src !== null && (!file || file.mime !== JS)) throw Error('Unavailable website script.');
        const code = file ? websiteText(file) : (node.textContent ?? '');
        if (code.trim())
          entries.push(add(code, file?.path ?? from, module, new Set(file ? [file.path] : [])));
      } catch {
        scripts.length = start;
        for (const [path, indexOf] of modules) if (indexOf >= start) modules.delete(path);
        skipped = true;
      }
    },
    scripts,
    entries,
    get skipped() {
      return skipped;
    },
  };
}

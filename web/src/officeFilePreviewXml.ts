import { invalidOfficeFile, type openOfficeZip } from './officeFilePreviewZip';

const transitional = 'http://schemas.openxmlformats.org/';
const strict = 'http://purl.oclc.org/ooxml/';
const namespaces = {
  word: [transitional + 'wordprocessingml/2006/main', strict + 'wordprocessingml/main'],
  sheet: [transitional + 'spreadsheetml/2006/main', strict + 'spreadsheetml/main'],
  slides: [transitional + 'presentationml/2006/main', strict + 'presentationml/main'],
  draw: [transitional + 'drawingml/2006/main', strict + 'drawingml/main'],
  types: [transitional + 'package/2006/content-types'],
  package: [transitional + 'package/2006/relationships'],
  rel: [
    transitional + 'officeDocument/2006/relationships',
    strict + 'officeDocument/relationships',
  ],
};
type Family = keyof typeof namespaces;
export type OfficeXmlParser = (text: string) => Document;
export type OfficeZip = ReturnType<typeof openOfficeZip>;

export function xmlElement(element: Element, family: Family, local: string) {
  return element.localName === local && namespaces[family].includes(element.namespaceURI ?? '');
}

export function children(element: Element) {
  const result: Element[] = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child as Element);
  }
  return result;
}

export function direct(element: Element, family: Family, local: string) {
  return children(element).filter((child) => xmlElement(child, family, local));
}

export function* descendants(element: Element): IterableIterator<Element> {
  const stack = children(element).reverse();
  while (stack.length) {
    const child = stack.pop()!;
    yield child;
    for (let node = child.lastChild; node; node = node.previousSibling) {
      if (node.nodeType === 1) stack.push(node as Element);
    }
  }
}

export async function officeXml(
  zip: OfficeZip,
  path: string,
  parse: OfficeXmlParser,
  family: Family,
  local: string,
) {
  const text = await zip.readXml(path);
  // Office parts do not require DTDs or application processing instructions.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b|<\?(?!xml\s)/iu.test(text) || text.includes('\0')) {
    invalidOfficeFile();
  }
  let markup = 0;
  for (let index = text.indexOf('<'); index !== -1; index = text.indexOf('<', index + 1)) {
    if (++markup > 120000) invalidOfficeFile();
  }
  const doc = parse(text);
  const root = doc.documentElement;
  if (!root || doc.doctype || !xmlElement(root, family, local)) invalidOfficeFile();
  let count = 0;
  for (const element of descendants(root)) {
    if (element.localName === 'parsererror' || ++count > 60000) invalidOfficeFile();
  }
  return root;
}

export function relationshipId(element: Element) {
  for (const namespace of namespaces.rel) {
    const id = element.getAttributeNS(namespace, 'id');
    if (id) return id;
  }
  return undefined;
}

function internalPart(from: string, target: string) {
  if (!/^[A-Za-z0-9._/-]{1,500}$/.test(target) || target.startsWith('//')) return;
  const path = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (!segment) return;
    if (segment === '..') {
      if (!path.length) return;
      path.pop();
    } else if (segment !== '.') path.push(segment);
  }
  return path.join('/');
}

export async function officeRelationships(zip: OfficeZip, from: string, parse: OfficeXmlParser) {
  const parts = from.split('/');
  const file = parts.pop();
  const path = [...parts, '_rels', `${file}.rels`].join('/');
  const result = new Map<string, { path: string; kind: string }>();
  if (!zip.has(path)) return result;
  const root = await officeXml(zip, path, parse, 'package', 'Relationships');
  const rows = direct(root, 'package', 'Relationship');
  if (rows.length > 1000) invalidOfficeFile();
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.getAttribute('Id');
    if (!id || ids.has(id)) invalidOfficeFile();
    ids.add(id);
    const mode = row.getAttribute('TargetMode');
    if (mode && mode !== 'Internal') continue;
    const type = row.getAttribute('Type') ?? '';
    const base = namespaces.rel.find((namespace) => type.startsWith(`${namespace}/`));
    const target = internalPart(from, row.getAttribute('Target') ?? '');
    if (base && target) result.set(id, { path: target, kind: type.slice(base.length + 1) });
  }
  return result;
}

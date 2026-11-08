import {
  children,
  descendants,
  direct,
  officeRelationships,
  officeXml,
  relationshipId,
  xmlElement,
  type OfficeXmlParser,
  type OfficeZip,
} from './officeFilePreviewXml';
import { invalidOfficeFile, openOfficeZip } from './officeFilePreviewZip';

export type OfficePreviewFormat = 'docx' | 'xlsx' | 'pptx';
type OfficeRow = { number?: number; cells: string[] };
export type OfficePreviewBlock =
  { kind: 'paragraph'; text: string } | { kind: 'table'; rows: OfficeRow[]; columns?: string[] };
type OfficePage = { number: number; name?: string; blocks: OfficePreviewBlock[] };
export type OfficePreview = { pages: OfficePage[]; limited: boolean };

const rowLimit = 120;
const columnLimit = 32;
const pageLimit = 12;
const paragraphLimit = 180;
const mainParts = {
  docx: ['word/', 'wordprocessingml.document', 'word', 'document'],
  xlsx: ['xl/', 'spreadsheetml.sheet', 'sheet', 'workbook'],
  pptx: ['ppt/', 'presentationml.presentation', 'slides', 'presentation'],
} as const;

function previewBudget() {
  let remaining = 120000;
  return {
    limited: false,
    text(raw: string, maximum: number) {
      const value = raw.slice(0, Math.min(maximum, remaining));
      remaining -= value.length;
      this.limited ||= value.length < raw.length;
      return value;
    },
  };
}
type Budget = ReturnType<typeof previewBudget>;

function rootPart(path: string, prefix: string) {
  return path.toLowerCase().startsWith(prefix) && path.toLowerCase().endsWith('.xml');
}

async function findMainPart(zip: OfficeZip, parse: OfficeXmlParser, format: OfficePreviewFormat) {
  const [prefix, type] = mainParts[format];
  const relationships = await officeRelationships(zip, '', parse);
  const documents = [...relationships.values()].filter((rel) => rel.kind === 'officeDocument');
  const part = documents[0]?.path;
  if (documents.length !== 1 || !part || !rootPart(part, prefix)) invalidOfficeFile();
  const root = await officeXml(zip, '[Content_Types].xml', parse, 'types', 'Types');
  const mime = `application/vnd.openxmlformats-officedocument.${type}.main+xml`;
  const entries = direct(root, 'types', 'Override').filter(
    (row) => row.getAttribute('PartName')?.toLowerCase() === `/${part.toLowerCase()}`,
  );
  if (entries.length !== 1 || entries[0].getAttribute('ContentType') !== mime) invalidOfficeFile();
  return part;
}

function leafText(element: Element) {
  let result = '';
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3 || node.nodeType === 4) result += node.nodeValue ?? '';
  }
  return result;
}

function paragraph(element: Element, family: 'word' | 'draw', budget: Budget) {
  let result = '';
  for (const child of descendants(element)) {
    if (xmlElement(child, family, 't')) result += leafText(child);
    if (xmlElement(child, family, 'tab')) result += '\t';
    if (xmlElement(child, family, 'br')) result += '\n';
    if (result.length > 5000) {
      budget.limited = true;
      return budget.text(result.trim(), 5000);
    }
  }
  return budget.text(result.trim(), 5000);
}

function wordTable(
  element: Element,
  budget: Budget,
  cellBudget: { remaining: number },
): OfficePreviewBlock {
  const rows = direct(element, 'word', 'tr');
  budget.limited ||= rows.length > rowLimit;
  return {
    kind: 'table',
    rows: rows.slice(0, rowLimit).flatMap((row) => {
      const cells = direct(row, 'word', 'tc');
      const count = Math.min(cells.length, columnLimit, cellBudget.remaining);
      budget.limited ||= count < cells.length;
      cellBudget.remaining -= count;
      if (!count) return [];
      return [
        {
          cells: cells.slice(0, count).map((cell) => {
            const paragraphs = direct(cell, 'word', 'p');
            budget.limited ||= paragraphs.length > 10;
            return paragraphs
              .slice(0, 10)
              .map((p) => paragraph(p, 'word', budget))
              .join('\n');
          }),
        },
      ];
    }),
  };
}

function wordPage(document: Element, budget: Budget): OfficePage {
  const body = direct(document, 'word', 'body')[0];
  if (!body) invalidOfficeFile();
  const blocks: OfficePreviewBlock[] = [];
  const cellBudget = { remaining: 4000 };
  function read(parent: Element, depth: number) {
    if (depth > 12) {
      budget.limited = true;
      return;
    }
    for (const item of children(parent)) {
      if (blocks.length >= paragraphLimit) {
        budget.limited = true;
        break;
      }
      if (xmlElement(item, 'word', 'p')) {
        const value = paragraph(item, 'word', budget);
        if (value) blocks.push({ kind: 'paragraph', text: value });
      } else if (xmlElement(item, 'word', 'tbl')) {
        blocks.push(wordTable(item, budget, cellBudget));
      } else if (xmlElement(item, 'word', 'sdt') || xmlElement(item, 'word', 'sdtContent')) {
        read(item, depth + 1);
      }
    }
  }
  read(body, 0);
  return { number: 1, blocks };
}

function richSheetText(container: Element) {
  return children(container)
    .flatMap((child) => {
      if (xmlElement(child, 'sheet', 't')) return [leafText(child)];
      if (xmlElement(child, 'sheet', 'r')) {
        return direct(child, 'sheet', 't').map(leafText);
      }
      return [];
    })
    .join('');
}

function integer(value: string | null, maximum: number) {
  if (!value || !/^\d{1,8}$/.test(value) || Number(value) > maximum) return undefined;
  return Number(value);
}

function columnIndex(reference: string | null) {
  if (!reference) return undefined;
  const letters = /^([A-Z]{1,3})[1-9]\d{0,6}$/.exec(reference)?.[1];
  if (!letters) invalidOfficeFile();
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  if (index > 16384) invalidOfficeFile();
  return index - 1;
}

function columnName(index: number) {
  return (
    (index >= 26 ? String.fromCharCode(64 + Math.floor(index / 26)) : '') +
    String.fromCharCode(65 + (index % 26))
  );
}

function sheetValue(cell: Element, strings: string[]) {
  const stored = direct(cell, 'sheet', 'v')[0];
  const cached = stored ? leafText(stored) : '';
  const type = cell.getAttribute('t');
  if (type === 'inlineStr') {
    const rich = direct(cell, 'sheet', 'is')[0];
    return rich ? richSheetText(rich) : '';
  }
  if (type === 's') {
    const index = integer(cached, strings.length - 1);
    if (index === undefined) invalidOfficeFile();
    return strings[index];
  }
  if (type === 'b') return cached === '1' ? 'TRUE' : cached === '0' ? 'FALSE' : '';
  // Display saved values, including formula results, without evaluating expressions.
  return cached;
}

function hidden(value: string | null) {
  return value === '1' || value === 'true';
}

function sheetTable(worksheet: Element, strings: string[], budget: Budget): OfficePreviewBlock {
  const sheetData = direct(worksheet, 'sheet', 'sheetData')[0];
  if (!sheetData) invalidOfficeFile();
  const cols = direct(worksheet, 'sheet', 'cols').flatMap((list) => direct(list, 'sheet', 'col'));
  const hiddenColumns = new Set<number>();
  for (const col of cols) {
    if (!hidden(col.getAttribute('hidden'))) continue;
    const first = integer(col.getAttribute('min'), 16384);
    const last = integer(col.getAttribute('max'), 16384);
    if (!first || !last || last < first) continue;
    for (let index = first - 1; index < Math.min(last, columnLimit); index++)
      hiddenColumns.add(index);
  }
  const rows: OfficeRow[] = [];
  let width = 0;
  let rowNumber = 0;
  for (const row of direct(sheetData, 'sheet', 'row')) {
    rowNumber = integer(row.getAttribute('r'), 1048576) ?? rowNumber + 1;
    if (hidden(row.getAttribute('hidden'))) continue;
    if (rows.length >= rowLimit) {
      budget.limited = true;
      break;
    }
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cell of direct(row, 'sheet', 'c')) {
      const index = columnIndex(cell.getAttribute('r')) ?? nextColumn;
      nextColumn = index + 1;
      if (index >= columnLimit) {
        budget.limited = true;
      } else if (!hiddenColumns.has(index)) {
        cells[index] = budget.text(sheetValue(cell, strings), 1200);
      }
    }
    if (cells.some(Boolean)) {
      width = Math.max(width, cells.length);
      rows.push({ number: rowNumber, cells });
    }
  }
  const indices = Array.from({ length: width }, (_, index) => index).filter(
    (index) => !hiddenColumns.has(index),
  );
  return {
    kind: 'table',
    rows: rows.map((row) => ({ ...row, cells: indices.map((index) => row.cells[index] ?? '') })),
    columns: indices.map(columnName),
  };
}

async function sheetPages(
  zip: OfficeZip,
  parse: OfficeXmlParser,
  part: string,
  workbook: Element,
  budget: Budget,
) {
  const rels = await officeRelationships(zip, part, parse);
  const sheets = direct(workbook, 'sheet', 'sheets')[0];
  if (!sheets) invalidOfficeFile();
  const visible = direct(sheets, 'sheet', 'sheet').filter((sheet) => {
    const state = sheet.getAttribute('state');
    return !state || state === 'visible';
  });
  const shared = [...rels.values()].filter((value) => value.kind === 'sharedStrings');
  if (shared.length > 1) invalidOfficeFile();
  let strings: string[] = [];
  if (shared.length) {
    if (!rootPart(shared[0].path, 'xl/')) invalidOfficeFile();
    const root = await officeXml(zip, shared[0].path, parse, 'sheet', 'sst');
    strings = direct(root, 'sheet', 'si').map(richSheetText);
  }
  const pages: OfficePage[] = [];
  for (const [index, sheet] of visible.entries()) {
    if (pages.length >= pageLimit) {
      budget.limited = true;
      break;
    }
    const rel = rels.get(relationshipId(sheet) ?? '');
    if (rel?.kind !== 'worksheet' || !rootPart(rel.path, 'xl/')) {
      budget.limited = true;
      continue;
    }
    const worksheet = await officeXml(zip, rel.path, parse, 'sheet', 'worksheet');
    pages.push({
      number: index + 1,
      name: budget.text(sheet.getAttribute('name') ?? '', 120),
      blocks: [sheetTable(worksheet, strings, budget)],
    });
  }
  if (visible.length && !pages.length) invalidOfficeFile();
  return pages;
}

async function slidePages(
  zip: OfficeZip,
  parse: OfficeXmlParser,
  part: string,
  presentation: Element,
  budget: Budget,
) {
  const rels = await officeRelationships(zip, part, parse);
  const slideList = direct(presentation, 'slides', 'sldIdLst')[0];
  const ids = slideList ? direct(slideList, 'slides', 'sldId') : [];
  const pages: OfficePage[] = [];
  for (const [index, slideId] of ids.entries()) {
    if (index >= pageLimit) {
      budget.limited = true;
      break;
    }
    const rel = rels.get(relationshipId(slideId) ?? '');
    if (rel?.kind !== 'slide' || !rootPart(rel.path, 'ppt/')) invalidOfficeFile();
    const slide = await officeXml(zip, rel.path, parse, 'slides', 'sld');
    if (['0', 'false'].includes(slide.getAttribute('show') ?? '')) continue;
    const blocks: OfficePreviewBlock[] = [];
    const canvas = direct(slide, 'slides', 'cSld')[0];
    if (!canvas) invalidOfficeFile();
    for (const item of descendants(canvas)) {
      if (!xmlElement(item, 'draw', 'p')) continue;
      if (blocks.length >= paragraphLimit) {
        budget.limited = true;
        break;
      }
      const text = paragraph(item, 'draw', budget);
      if (text) blocks.push({ kind: 'paragraph', text });
    }
    pages.push({ number: index + 1, blocks });
  }
  return pages;
}

export async function readOfficeFilePreview(
  bytes: Uint8Array,
  format: OfficePreviewFormat,
  signal: AbortSignal,
  parse: OfficeXmlParser = (text) => new DOMParser().parseFromString(text, 'application/xml'),
): Promise<OfficePreview> {
  const zip = openOfficeZip(bytes, signal);
  const part = await findMainPart(zip, parse, format);
  const [, , family, tag] = mainParts[format];
  const root = await officeXml(zip, part, parse, family, tag);
  const budget = previewBudget();
  const pages =
    format === 'docx'
      ? [wordPage(root, budget)]
      : format === 'xlsx'
        ? await sheetPages(zip, parse, part, root, budget)
        : await slidePages(zip, parse, part, root, budget);
  signal.throwIfAborted();
  return { pages, limited: budget.limited };
}

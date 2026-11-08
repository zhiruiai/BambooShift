import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser as TestXmlParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { docxFixture } from '../../server/workers/document-worker/fixtures';
import { readOfficeFilePreview, type OfficePreviewFormat } from './officeFilePreview';

const ns = 'http://schemas.openxmlformats.org/';
const rel = ns + 'officeDocument/2006/relationships';
const sheet = ns + 'spreadsheetml/2006/main';
const slides = ns + 'presentationml/2006/main';
const draw = ns + 'drawingml/2006/main';
const word = ns + 'wordprocessingml/2006/main';
const packageRel = ns + 'package/2006/relationships';
const packageTypes = ns + 'package/2006/content-types';

const parse = (text: string) =>
  new TestXmlParser({
    errorHandler: () => {
      throw new Error('Invalid XML fixture');
    },
  }).parseFromString(text, 'application/xml');

function preview(
  bytes: Uint8Array,
  format: OfficePreviewFormat,
  signal = new AbortController().signal,
) {
  return readOfficeFilePreview(bytes, format, signal, parse);
}

async function officePackage(
  part: string,
  type: string,
  entries: Record<string, string>,
  streamFiles = true,
) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="${packageTypes}"><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`,
  );
  zip.file('_rels/.rels', relationships([['rDoc', 'officeDocument', part]]));
  for (const [name, value] of Object.entries(entries))
    zip.file(name, value, { createFolders: false });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles });
}

function relationships(rows: string[][]) {
  return `<Relationships xmlns="${packageRel}">${rows
    .map(
      ([id, kind, path, mode]) =>
        `<Relationship Id="${id}" Type="${rel}/${kind}" Target="${path}"${mode ? ` TargetMode="${mode}"` : ''}/>`,
    )
    .join('')}</Relationships>`;
}

test('Word preview keeps paragraph and table order and treats markup as plain text', async () => {
  const main = 'word/document.xml';
  const bytes = await officePackage(main, 'wordprocessingml.document', {
    [main]: `<w:document xmlns:w="${word}"><w:body><w:p><w:r><w:t>文字 &lt;script&gt;</w:t><w:br/><w:t>Second line</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
    'word/_rels/document.xml.rels': relationships([
      ['rLink', 'hyperlink', 'https://example.invalid', 'External'],
    ]),
  });
  assert.deepEqual(await preview(bytes, 'docx'), {
    pages: [
      {
        number: 1,
        blocks: [
          { kind: 'paragraph', text: '文字 <script>\nSecond line' },
          { kind: 'table', rows: [{ cells: ['Cell'] }] },
        ],
      },
    ],
    limited: false,
  });
  await assert.rejects(preview(bytes, 'xlsx'));
});

test('Excel preview follows visible worksheet order and displays only cached formula values', async () => {
  const main = 'xl/workbook.xml';
  const bytes = await officePackage(main, 'spreadsheetml.sheet', {
    [main]: `<workbook xmlns="${sheet}" xmlns:r="${rel}"><sheets><sheet name="Revenues" r:id="r2"/><sheet name="Internal" state="veryHidden" r:id="r3"/><sheet name="Costs" r:id="r1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships([
      ['r1', 'worksheet', 'worksheets/sheet1.xml'],
      ['r2', 'worksheet', '/xl/worksheets/sheet2.xml'],
      ['r3', 'worksheet', 'https://example.invalid/hidden.xml', 'External'],
      ['rStrings', 'sharedStrings', 'sharedStrings.xml'],
    ]),
    'xl/sharedStrings.xml': `<sst xmlns="${sheet}"><si><r><t>Sample</t></r><r><t> value</t></r><rPh><t>Ignore</t></rPh></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${sheet}"><sheetData/></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${sheet}"><cols><col min="2" max="2" hidden="1"/></cols><sheetData><row r="5"><c r="A5" t="s"><v>0</v></c><c r="B5" t="inlineStr"><is><t>Hidden cell</t></is></c><c r="C5"><f>HYPERLINK("https://example.invalid")</f><v>42</v></c><c r="D5" t="inlineStr"><is><t>End</t></is></c></row><row r="6" hidden="1"><c><v>700</v></c></row></sheetData></worksheet>`,
  });
  const result = await preview(bytes, 'xlsx');
  assert.deepEqual(
    result.pages.map((page) => page.name),
    ['Revenues', 'Costs'],
  );
  assert.deepEqual(result.pages[0].blocks, [
    {
      kind: 'table',
      columns: ['A', 'C', 'D'],
      rows: [{ number: 5, cells: ['Sample value', '42', 'End'] }],
    },
  ]);
  assert.equal(result.limited, false);
});

test('slide preview follows the presentation order and reads drawing text without media', async () => {
  const main = 'ppt/presentation.xml';
  const sample = (value: string, visible = true) =>
    `<p:sld xmlns:p="${slides}" xmlns:a="${draw}" show="${visible ? 1 : 0}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp><p:pic/></p:spTree></p:cSld></p:sld>`;
  const bytes = await officePackage(main, 'presentationml.presentation', {
    [main]: `<p:presentation xmlns:p="${slides}" xmlns:r="${rel}"><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/><p:sldId r:id="r3"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships([
      ['r1', 'slide', 'slides/slide1.xml'],
      ['r2', 'slide', 'slides/slide2.xml'],
      ['r3', 'slide', 'slides/slide3.xml'],
    ]),
    'ppt/slides/slide1.xml': sample('Second'),
    'ppt/slides/slide2.xml': sample('First'),
    'ppt/slides/slide3.xml': sample('Hidden slide', false),
  });
  assert.deepEqual((await preview(bytes, 'pptx')).pages, [
    { number: 1, blocks: [{ kind: 'paragraph', text: 'First' }] },
    { number: 2, blocks: [{ kind: 'paragraph', text: 'Second' }] },
  ]);
});

test('Office preview rejects external relationship paths, macros, and XML application instructions', async () => {
  const main = 'word/document.xml';
  const text = `<w:document xmlns:w="${word}"><w:body/></w:document>`;
  const external = await officePackage(main, 'wordprocessingml.document', {
    '_rels/.rels': relationships([
      ['rDoc', 'officeDocument', 'https://example.invalid/fetch.xml', 'External'],
    ]),
    [main]: text,
  });
  const macro = await officePackage(main, 'wordprocessingml.template', { [main]: text });
  const entities = await officePackage(main, 'wordprocessingml.document', {
    [main]: `<!DOCTYPE main [<!ENTITY unsafe SYSTEM "https://example.invalid/fetch">]>${text}`,
  });
  const stylesheet = await officePackage(main, 'wordprocessingml.document', {
    [main]: `<?xml-stylesheet href="https://example.invalid/fetch"?>${text}`,
  });
  for (const bytes of [external, macro, entities, stylesheet])
    await assert.rejects(preview(bytes, 'docx'));
});

test('ZIP expansion, malformed records and cancelled requests fail closed', async () => {
  const oversized = docxFixture(
    'Example',
    { 'word/bomb.xml': Buffer.alloc(9 * 1024 * 1024, 88) },
    true,
  );
  await assert.rejects(preview(oversized, 'docx'));
  await assert.rejects(preview(docxFixture('Example', { '../elsewhere.xml': 'no' }), 'docx'));
  const original = docxFixture('Example', {}, true);
  await assert.rejects(preview(original.subarray(0, -1), 'docx'));
  const wrongSize = Buffer.from(original);
  const end = wrongSize.length - 22;
  for (let at = wrongSize.readUInt32LE(end + 16); at < end;) {
    const length = wrongSize.readUInt16LE(at + 28);
    if (wrongSize.toString('utf8', at + 46, at + 46 + length) === 'word/document.xml') {
      wrongSize.writeUInt32LE(1, wrongSize.readUInt32LE(at + 42) + 22);
      wrongSize.writeUInt32LE(1, at + 24);
      break;
    }
    at += 46 + length + wrongSize.readUInt16LE(at + 30) + wrongSize.readUInt16LE(at + 32);
  }
  await assert.rejects(preview(wrongSize, 'docx'));
  await assert.rejects(preview(original, 'docx', AbortSignal.abort()), { name: 'AbortError' });
});

test('large text is cut at preview limits and flagged as partial', async () => {
  const result = await preview(docxFixture('a'.repeat(5001)), 'docx');
  assert.equal(result.limited, true);
  assert.deepEqual(result.pages[0].blocks, [{ kind: 'paragraph', text: 'a'.repeat(5000) }]);
});

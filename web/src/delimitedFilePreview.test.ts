import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDelimitedPreview, TABLE_PREVIEW_LIMIT } from './delimitedFilePreview';

test('table preview handles UTF-8 BOM, CRLF, quoted separators, doubled quotes and multiline cells', () => {
  assert.deepEqual(
    parseDelimitedPreview('\uFEFFname,notes,value\r\n中文,"one, ""two""\r\nthree",42\r\n', ','),
    {
      rows: [
        ['name', 'notes', 'value'],
        ['中文', 'one, "two"\r\nthree', '42'],
      ],
      truncated: false,
    },
  );
  assert.deepEqual(parseDelimitedPreview('title\t"one\ttwo"\t\n=SUM(A1)\t<script/>', '\t'), {
    rows: [
      ['title', 'one\ttwo', ''],
      ['=SUM(A1)', '<script/>'],
    ],
    truncated: false,
  });
});

test('table preview clips large cells, columns and rows and rejects incomplete quotes', () => {
  const text = Array.from({ length: TABLE_PREVIEW_LIMIT.rows + 1 }, () =>
    [
      'a'.repeat(TABLE_PREVIEW_LIMIT.cellLength + 1),
      ...Array(TABLE_PREVIEW_LIMIT.columns).fill('x'),
    ].join(','),
  ).join('\n');
  const result = parseDelimitedPreview(text, ',');
  assert.equal(result?.truncated, true);
  assert.equal(result?.rows.length, TABLE_PREVIEW_LIMIT.rows);
  assert.equal(result?.rows[0].length, TABLE_PREVIEW_LIMIT.columns);
  assert.equal(result?.rows[0][0].length, TABLE_PREVIEW_LIMIT.cellLength);
  assert.equal(parseDelimitedPreview('name,"missing closing quote', ','), undefined);
  assert.equal(parseDelimitedPreview('name,"quoted"trailing junk', ','), undefined);
  assert.deepEqual(parseDelimitedPreview('', ','), { rows: [], truncated: false });
});

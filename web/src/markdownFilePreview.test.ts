import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './components/Markdown';

const render = (text: string, passive?: boolean) =>
  renderToStaticMarkup(createElement(Markdown, { text, passive }));

test('passive Markdown renders headings, lists, code and GFM formatting', () => {
  const result = render(
    [
      '# Synthetic heading',
      '',
      'Text with **strong emphasis** and ~~old text~~.',
      '',
      '- First',
      '- Second',
      '',
      '1. Numbered',
      '2. Another',
      '',
      '- [x] Reviewed',
      '- [ ] Pending',
      '',
      '| Name | Value |',
      '| --- | ---: |',
      '| A | 1 |',
      '',
      '```js',
      'const syntax = "<code>";',
      '```',
      '',
      '> Synthetic quote',
    ].join('\n'),
    true,
  );
  for (const expected of [
    '<h1>Synthetic heading</h1>',
    '<strong>strong emphasis</strong>',
    '<del>old text</del>',
    '<ul>',
    '<li>First</li>',
    '<ol>',
    '<li>Numbered</li>',
    'type="checkbox"',
    'disabled=""',
    '<table>',
    '<th>Name</th>',
    '<td>A</td>',
    '<pre><code class="language-js">',
    '&lt;code&gt;',
    '<blockquote>',
  ])
    assert.ok(result.includes(expected), expected);
});

test('artifact links, images, HTML and GFM auto links emit no requests or navigation targets', () => {
  const result = render(
    [
      '[External](https://external.example/synthetic-target)',
      '[Relative](/api/files/private/download)',
      '[Unsafe](javascript:alert%281%29)',
      'https://external.example/autolink',
      '![External diagram](https://external.example/image.png)',
      '![](/api/files/private/download)',
      '![Embedded](data:image/svg+xml;base64,PHN2Zy8+)',
      '',
      '<img src="https://external.example/raw.png" onerror="alert(1)">',
      '<iframe src="https://external.example/frame"></iframe>',
      '<script>ACTIVE_MARKER</script>',
      '<style>body { background: url(https://external.example/css); }</style>',
    ].join('\n'),
    true,
  );
  for (const label of [
    'External',
    'Relative',
    'Unsafe',
    'External diagram',
    'Embedded',
    'autolink',
  ])
    assert.match(result, new RegExp(label));
  assert.doesNotMatch(
    result,
    /<(?:a\b|img|iframe|script|style)|\b(?:href|src|srcset|onerror)=|ACTIVE_MARKER|synthetic-target|private\/download|image\.png/,
  );
  assert.match(
    render('[Chat link](https://external.example/chat)', false),
    /href="https:\/\/external\.example\/chat"/,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { websiteTextDiff } from './websiteTextDiff';

test('text differences preserve exact changed lines, numbers and HTML as data', () => {
  const diff = websiteTextDiff(
    'heading\nold\nfooter',
    'heading\n<script>changed()</script>\nfooter',
  );
  assert.equal(diff.kind, 'ready');
  if (diff.kind !== 'ready') return;
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.deepEqual(diff.rows, [
    { kind: 'same', text: 'heading', before: 1, after: 1 },
    { kind: 'removed', text: 'old', before: 2 },
    { kind: 'added', text: '<script>changed()</script>', after: 2 },
    { kind: 'same', text: 'footer', before: 3, after: 3 },
  ]);
});

test('line diff handles additions, removals, duplicates and final newlines without losing text', () => {
  const cases = [
    ['', 'new'],
    ['old', ''],
    ['a\na\nb', 'a\nb\na'],
    ['a\n', 'a'],
  ];
  let seed = 17;
  const random = () => (seed = (seed * 48271) % 2147483647);
  for (let iteration = 0; iteration < 60; iteration++) {
    const sample = () =>
      Array.from({ length: (random() % 5) + 1 }, () => String(random() % 3)).join('\n');
    cases.push([sample(), sample()]);
  }
  for (const [before, after] of cases) {
    const diff = websiteTextDiff(before, after);
    assert.equal(diff.kind, 'ready');
    if (diff.kind !== 'ready' || before === after) continue;
    const lines = diff.rows.filter((row) => row.kind !== 'gap');
    assert.deepEqual(
      lines.filter((row) => row.kind !== 'added').map((row) => row.text),
      before ? before.split('\n') : [],
    );
    assert.deepEqual(
      lines.filter((row) => row.kind !== 'removed').map((row) => row.text),
      after ? after.split('\n') : [],
    );
  }
  const format = websiteTextDiff('a\r\nb', 'a\nb');
  assert.equal(format.kind === 'ready' && format.formatOnly, true);
});

test('context and output are bounded and expensive/minified rewrites decline before quadratic work', () => {
  const lines = Array.from({ length: 100 }, (_, index) => 'line ' + index);
  const next = [...lines];
  next[50] = 'edited';
  const context = websiteTextDiff(lines.join('\n'), next.join('\n'));
  assert.equal(context.kind, 'ready');
  if (context.kind === 'ready') {
    assert.deepEqual(context.rows[0], { kind: 'gap', count: 47 });
    assert.deepEqual(context.rows.at(-1), { kind: 'gap', count: 46 });
    assert.equal(context.rows.length, 10);
  }
  const added = websiteTextDiff('', Array.from({ length: 800 }, () => 'new').join('\n'));
  assert.equal(added.kind === 'ready' && added.truncated, true);
  assert.equal(added.kind === 'ready' && added.added, 800);
  assert.equal(added.kind === 'ready' && added.rows.length, 400);
  assert.equal(websiteTextDiff('x'.repeat(2001), 'short').kind, 'limited');
  assert.equal(websiteTextDiff('a\n'.repeat(1500), 'b\n'.repeat(1500)).kind, 'limited');
});

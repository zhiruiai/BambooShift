import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { nonEnglishComments, pythonCommentScanner } from './policy/comments.mjs';
import { smallFonts } from './policy/fonts.mjs';

test('comment policy distinguishes English comments from Chinese interface copy and fixture text', () => {
  const file = {
    path: 'example.tsx',
    text: '// Explain the boundary.\nconst value = "中文文案 // 数据";\n/* 中文注释 */\nconst view = <span>中文界面</span>;\n',
  };
  assert.deepEqual(
    nonEnglishComments(file).map((issue) => issue.line),
    [3],
  );
  assert.equal(
    nonEnglishComments({
      path: 'example.css',
      text: '.label::after { content: "中文"; } /* 中文注释 */',
    }).length,
    1,
  );
  assert.equal(
    nonEnglishComments({
      path: 'example.rs',
      text: 'let text = "中文 // 数据"; // Explain the value.\n// 中文注释',
    }).length,
    1,
  );
});
test('Python tokenizer distinguishes comments from hashes in quoted strings', () => {
  const scan = spawnSync('python3', ['-c', pythonCommentScanner], {
    encoding: 'utf8',
    input: JSON.stringify([
      { path: 'example.py', text: 'value = "中文 # 数据"\n# 中文注释\n# English explanation.\n' },
    ]),
  });
  assert.equal(scan.status, 0, scan.stderr);
  assert.deepEqual(
    JSON.parse(scan.stdout).map((issue) => issue.line),
    [2],
  );
});
test('mobile comments ignore raw and multiline localized string data', () => {
  for (const extension of ['dart', 'kt', 'java']) {
    const file = {
      path: `mobile/example.${extension}`,
      text: `const label = "中文 // 数据";\nconst multiline = """中文 /* 数据 */""";\n// 中文注释\n/* English explanation. */`,
    };
    assert.deepEqual(nonEnglishComments(file).map((issue) => issue.line), [3]);
  }
  assert.deepEqual(nonEnglishComments({
    path: 'mobile/example.dart',
    text: "final raw = r'中文 \\ // 数据';\nfinal multi = '''中文 // 数据''';\n/* 中文注释 */",
  }).map((issue) => issue.line), [3]);
});
test('font policy accepts the boundary and shorthand line height while rejecting smaller text', () => {
  const file = {
    path: 'example.css',
    text: '.one {font-size: 12px}.two {font-size:11px}.three {font: 400 14px/10px sans-serif}.four {font: 10px sans-serif}',
  };
  assert.equal(smallFonts(file).length, 2);
  assert.deepEqual(smallFonts({ ...file, text: '.icon {width:10px;height:8px}' }), []);
});

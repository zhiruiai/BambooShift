import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { resources } from './i18n';

const tokens = (text: string) => text.match(/\{\{[^}]+\}\}/g)?.sort() ?? [];
const edge = (text: string) => [text.match(/^\s*/)?.[0], text.match(/\s*$/)?.[0]];

test('every namespace has complete English keys, interpolation contracts and intentional edge whitespace', () => {
  assert.deepEqual(Object.keys(resources.en).sort(), Object.keys(resources['zh-CN']).sort());
  for (const name of Object.keys(resources['zh-CN']) as Array<keyof (typeof resources)['zh-CN']>) {
    const chinese: Record<string, string> = resources['zh-CN'][name];
    const english: Record<string, string> = resources.en[name];
    assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort(), name);
    for (const [key, source] of Object.entries(chinese)) {
      const value = english[key];
      assert.equal(typeof value, 'string', `${name}:${key}`);
      assert.ok(value.trim(), `${name}:${key} is empty`);
      assert.deepEqual(tokens(value), tokens(source), `${name}:${key} placeholders`);
      assert.deepEqual(edge(value), edge(source), `${name}:${key} whitespace`);
      assert.doesNotMatch(value, /[\u3400-\u9fff]/, `${name}:${key} was not translated`);
    }
  }
});

async function sourceFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!['browserTests', 'testSupport', 'i18n'].includes(entry.name))
        files.push(...(await sourceFiles(file)));
    } else if (/\.tsx?$/.test(file) && !/\.(?:test\.tsx?|d\.ts)$/.test(file)) files.push(file);
  }
  return files;
}

function localizedPreviewText(node: ts.Node): boolean {
  // The preview frame has its own locale. Its Chinese text is either the
  // selected branch of a locale check or the Chinese argument to announce().
  for (let parent = node.parent; ts.isExpression(parent); node = parent, parent = parent.parent) {
    if (
      (ts.isConditionalExpression(parent) &&
        parent.whenTrue === node &&
        ts.isIdentifier(parent.condition) &&
        parent.condition.text === 'zh') ||
      (ts.isCallExpression(parent) &&
        parent.arguments[1] === node &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'announce')
    )
      return true;
  }
  return false;
}

function untranslatedLiterals(file: string, content: string) {
  const untranslated: string[] = [];
  function scan(source: ts.SourceFile, firstLine: number, preview = false) {
    function visit(node: ts.Node) {
      if (
        !preview &&
        file === join('web/src', 'htmlPreviewRuntime.ts') &&
        ts.isNoSubstitutionTemplateLiteral(node) &&
        ts.isTaggedTemplateExpression(node.parent) &&
        node.parent.tag.getText(source) === 'String.raw' &&
        ts.isVariableDeclaration(node.parent.parent) &&
        node.parent.parent.name.getText(source) === 'HTML_PREVIEW_RUNTIME'
      ) {
        const script = ts.createSourceFile(
          file,
          node.rawText ?? node.text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        scan(
          script,
          firstLine + source.getLineAndCharacterOfPosition(node.getStart(source)).line,
          true,
        );
        return;
      }
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isJsxText(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /[\u3400-\u9fff]/.test(node.text) &&
        !(preview && localizedPreviewText(node))
      ) {
        const line = firstLine + source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        untranslated.push(`${file}:${line} ${node.text.slice(0, 80)}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  scan(ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true), 1);
  return untranslated;
}

test('production UI literals are localized without inspecting comments, test data or user-generated content', async () => {
  const untranslated: string[] = [];
  const surfaces = ['web/src', 'operations/src'];
  for (const file of (await Promise.all(surfaces.map(sourceFiles))).flat())
    untranslated.push(...untranslatedLiterals(file, await readFile(file, 'utf8')));
  assert.deepEqual(untranslated, []);
});

test('the embedded preview scan retains coverage of unconditional and English-branch text', () => {
  const file = join('web/src', 'htmlPreviewRuntime.ts');
  const content = [
    'export const HTML_PREVIEW_RUNTIME = String.raw`',
    "announce('Correct', '正确');",
    "const title = zh ? '标题' : 'Title';",
    "const untranslated = '无条件';",
    "const english = zh ? '退出' : '英文分支';",
    '`;',
  ].join('\n');
  assert.deepEqual(untranslatedLiterals(file, content), [`${file}:4 无条件`, `${file}:5 英文分支`]);
});

import { displayAvatarColor } from '../../shared/avatar-palette';
import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

/** Evaluate the actual JSX bindings so this covers App wiring, without claiming GUI rendering. */
async function bindings() {
  const source = `${await workspaceSource()}\n${await readFile(new URL('./workspace/ComposerInput.tsx', import.meta.url), 'utf8')}`;
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const expressions: Record<string, string> = {};
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const literal = (name: string) =>
        attrs.find((attr) => attr.name.getText(ast) === name)?.initializer?.getText(ast);
      const target =
        literal('className') === '"message-content"'
          ? ['data-bot-accent', 'style']
          : node.tagName.getText(ast) === 'textarea' &&
              ['{composerRef}', '{props.composerRef}'].includes(literal('ref') || '')
            ? ['spellCheck', 'value']
            : [];
      for (const name of target) {
        const attr = attrs.find((attr) => attr.name.getText(ast) === name);
        if (
          attr?.initializer &&
          ts.isJsxExpression(attr.initializer) &&
          attr.initializer.expression
        )
          expressions[name] = attr.initializer.expression.getText(ast);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.deepEqual(Object.keys(expressions).sort(), [
    'data-bot-accent',
    'spellCheck',
    'style',
    'value',
  ]);
  return (name: string, context: Record<string, unknown>) => {
    const code = ts.transpileModule(`exports.result = (${expressions[name]});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const scope = {
      displayAvatarColor,
      ...context,
      props: context,
      exports: {} as { result?: unknown },
    };
    runInNewContext(code, scope);
    return scope.exports.result;
  };
}

test('actual App applies Bot accent only inside assistant content of a true private Bot chat', async () => {
  const evaluate = await bindings();
  const context = {
    m: { role: 'assistant' },
    conversation: { isGroup: false, agentIds: ['bot'] },
    agent: { color: '#F0B936' },
    appearance: { accent: 'bot', spellCheck: true },
  };
  assert.equal(evaluate('data-bot-accent', context), 'bot');
  assert.equal((evaluate('style', context) as any)['--message-bot-color'], '#F0B936');
  context.appearance.accent = 'neutral';
  assert.equal(evaluate('data-bot-accent', context), 'neutral');
  assert.equal(context.agent.color, '#F0B936', 'the Bot color and avatar source remain unchanged');
  for (const change of [
    { m: { role: 'user' } },
    { m: { role: 'system' } },
    { conversation: undefined },
    { conversation: { isGroup: true, agentIds: ['bot'] } },
    { conversation: { isGroup: false, agentIds: ['a', 'b'] } },
  ]) {
    assert.equal(evaluate('data-bot-accent', { ...context, ...change }), undefined);
    assert.equal(evaluate('style', { ...context, ...change }), undefined);
  }
  for (const color of ['url(https://example.invalid/a)', '#fff; color:red', 'red', '', null])
    assert.equal(evaluate('style', { ...context, agent: { color } }), undefined);
});

test('actual composer spell-check changes independently of an existing multiline draft', async () => {
  const evaluate = await bindings();
  const draft = '尚未发送的中文草稿\n@研究员 Please check teh plan';
  for (const spellCheck of [true, false, true]) {
    const context = { appearance: { spellCheck }, draft };
    assert.equal(evaluate('spellCheck', context), spellCheck);
    assert.equal(evaluate('value', context), draft);
  }
});

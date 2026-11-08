import { expandPureViews } from './testSupport/expandPureViews';
import { componentSource } from './testSupport/componentSource';
import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import React from 'react';
import ts from 'typescript';
import {
  ids,
  json,
  deferred,
  compile,
  text,
  all,
  harness,
  version2,
  firstTool,
  secondTool,
  grant,
  view,
  agent,
  action,
} from './testSupport/sharedBotAppsFixture';

test('same-count application grant changes invalidate old tool and list replies and old clicks while keeping the new authorized tools readable', async () => {
  const oldTool = deferred<Response>(),
    slowList = deferred<Response>();
  let lists = 0,
    toolReads = 0;
  const calls: any[] = [];
  const nextView = { ...view, tools: [{ name: secondTool.name, revision: secondTool.revision }] };
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith('/tools'))
      return ++toolReads === 1 ? oldTool.promise : json([secondTool]);
    return ++lists === 1 ? json([view]) : lists === 2 ? slowList.promise : json([nextView]);
  };
  const ui = await harness(
    'web/src/components/SharedBotApps.tsx',
    'SharedBotAppsContent',
    { agent, userId: ids.user },
    transport,
  );
  try {
    await ui.flush();
    const oldOpen = ui.button('查看 报告应用 的工具').props.onClick;
    oldOpen();
    await ui.flush();
    ui.props({ agent: { ...agent, sharedBot: { ...agent.sharedBot, appsRevision: 'share-b' } } });
    await ui.flush();
    oldTool.resolve(json([{ ...firstTool, description: '不得出现的旧工具' }]));
    await ui.flush();
    assert.doesNotMatch(ui.copy, /不得出现/);
    oldOpen();
    assert.equal(toolReads, 1);
    ui.props({ agent: { ...agent, sharedBot: { ...agent.sharedBot, appsRevision: 'share-c' } } });
    await ui.flush();
    slowList.resolve(json([{ ...view, name: '迟到旧应用' }]));
    await ui.flush();
    assert.doesNotMatch(ui.copy, /迟到旧应用/);
    assert.match(ui.copy, /report.write/);
    ui.button('查看 报告应用 的工具').props.onClick();
    await ui.flush();
    const details = all(ui.tree, (node) => node.type?.name === 'AppToolDetails');
    assert.equal(details[0].props.tool.name, secondTool.name);
    assert.ok(
      calls.every(
        (call) =>
          call.init.method === 'GET' && call.init.headers['X-OpenBot-Expected-User'] === ids.user,
      ),
    );
  } finally {
    ui.dispose();
  }
});

test('recipient app reads are read-only and stale account/unmount callbacks cannot fetch source tools', async () => {
  for (const outcome of ['user', 'revoke', 'unmount'] as const) {
    let calls = 0;
    const ui = await harness(
      'web/src/components/SharedBotApps.tsx',
      'SharedBotAppsContent',
      { agent, userId: ids.user },
      async () => {
        calls++;
        return json([view]);
      },
    );
    await ui.flush();
    const old = ui.button('查看 报告应用 的工具').props.onClick;
    if (outcome === 'user') ui.props({ userId: 'another' });
    if (outcome === 'revoke')
      ui.props({ agent: { ...agent, sharedBot: { ...agent.sharedBot, status: 'revoked' } } });
    if (outcome === 'unmount') ui.dispose();
    await ui.flush();
    const before = calls;
    old();
    await ui.flush();
    assert.equal(calls, before);
    assert.doesNotMatch(ui.copy, /重新授权|断开连接|移除连接/);
    ui.dispose();
  }
});

test('source approval uses the requester, labels publisher credentials, and routes only to the source read-only section', async () => {
  const parsed = await compile('web/src/components/AppActionCard.tsx');
  assert.equal(
    parsed.parseAppAction({ ...action, source: { ...action.source, shareId: '../owner' } }),
    undefined,
  );
  for (const mine of [true, false]) {
    const opened: any[] = [],
      calls: any[] = [];
    const ui = await harness(
      'web/src/components/AppActionCard.tsx',
      'AppActionContent',
      {
        action,
        owner: !mine,
        userId: mine ? ids.user : 'source-owner',
        workspaceId: ids.personal,
        onChanged: async () => {},
        onApps: (id: string) => opened.push(id),
      },
      async (url, init) => {
        calls.push({ url, init });
        return json({ ...action, status: 'running' });
      },
    );
    try {
      await ui.flush();
      assert.match(ui.copy, /使用 林 为 小松 共享的应用授权/);
      assert.doesNotMatch(ui.copy, /使用此空间的共享连接/);
      const open = ui.button('查看发布者提供的应用').props.onClick;
      open();
      assert.deepEqual(opened, [ids.share]);
      const approve = all(
        ui.tree,
        (node) => node.type === 'button' && text(node).includes('批准这一次'),
      )[0];
      assert.equal(!!approve, mine);
      if (mine) {
        approve.props.onClick();
        await ui.flush();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.headers['X-OpenBot-Expected-User'], ids.user);
      }
      ui.props({ userId: 'new-account' });
      await ui.flush();
      open();
      assert.equal(opened.length, 1);
    } finally {
      ui.dispose();
    }
  }
});

test('AppsDialog keeps personal management separate and source cards receive no connection credentials or management callbacks', async () => {
  const own = {
    id: 'own-app',
    name: '自己的应用',
    url: 'https://own.example/mcp',
    revision: 'revision-a',
    status: 'connected',
    authType: 'none',
    hasCredential: false,
    toolCount: 0,
  };
  const ui = await harness(
    'web/src/components/AppsDialog.tsx',
    'AppsDialogContent',
    {
      workspaceId: ids.personal,
      userId: ids.user,
      workspaceName: '个人空间',
      team: false,
      canManage: true,
      computerConnected: false,
      modelLabel: 'GLM',
      modelConfigured: true,
      sharedAgents: [agent],
      initialSharedBotId: ids.share,
      onFiles() {},
      onComputer() {},
      onSettings() {},
      onClose() {},
    },
    async () => json([own]),
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /发布者提供的应用/);
    assert.match(ui.copy, /当前空间的应用连接/);
    assert.match(ui.copy, /自己的应用/);
    const section = all(ui.tree, (node) => node.type?.name === 'SharedBotApps')[0];
    assert.deepEqual(Object.keys(section.props).sort(), ['agent', 'userId']);
    assert.equal(section.props.agent.sharedBot.shareId, ids.share);
    assert.ok(ui.button('添加'));
    ui.props({ initialSharedBotId: 'missing-source', sharedAgents: [] });
    await ui.flush();
    assert.match(ui.copy, /来源应用暂不可查看/);
  } finally {
    ui.dispose();
  }
});

test('actual App routes source cards and Bot details to the correct read-only group while generic application entries clear prior source selection', async () => {
  const source = await workspaceSource();
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let handler: ts.FunctionDeclaration | undefined;
  const attributes: Record<string, string> = {};
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'openApps') handler = node;
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      const names =
        tag === 'AppsDialog'
          ? ['sharedAgents', 'initialSharedBotId', 'initialProviderId']
          : tag === 'AgentDialog'
            ? ['onSharedApps']
            : ['AccountMenu', 'MobileHomeHeader', 'AppActionCard'].includes(tag)
              ? ['onApps']
              : [];
      for (const name of names) {
        const attr = node.attributes.properties.find(
          (prop) => ts.isJsxAttribute(prop) && prop.name.getText(ast) === name,
        ) as ts.JsxAttribute | undefined;
        if (
          attr?.initializer &&
          ts.isJsxExpression(attr.initializer) &&
          attr.initializer.expression
        )
          attributes[`${tag}_${name}`] = attr.initializer.expression.getText(ast);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(handler);
  const code = ts.transpileModule(
    `${handler.getText(ast)}\n${Object.entries(attributes)
      .map(([key, value]) => `exports.${key}=()=>(${value});`)
      .join('\n')}`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } },
  ).outputText;
  let active = true;
  const opened: any[] = [];
  const other = {
    ...agent,
    id: 'second-alias',
    sharedBot: { ...agent.sharedBot, shareId: version2 },
  };
  const context: any = {
    exports: {},
    sendScope: { ticket: () => 0, current: () => active },
    appsShareId: undefined,
    appsProviderId: 'github',
    setAppsCustomProposal() {},
    setAppsShareId: (value: any) => {
      context.appsShareId = value;
    },
    setAppsProviderId: (value: string | undefined) => {
      context.appsProviderId = value;
    },
    setModal: (value: any) => opened.push(value),
    activeAgent: other,
    members: [agent],
    data: { agents: [agent, other, { id: 'own-bot' }] },
    isSharedBot: (value: any) => !!value.sharedBot,
  };
  runInNewContext(code, context);
  context.exports.AppActionCard_onApps()(version2);
  assert.equal(context.appsShareId, version2);
  assert.equal(context.exports.AppsDialog_initialProviderId(), undefined);
  assert.deepEqual(
    Array.from(context.exports.AppsDialog_sharedAgents(), (item: any) => item.id),
    [agent.id, other.id],
  );
  for (const name of ['AccountMenu_onApps', 'MobileHomeHeader_onApps']) {
    context.appsShareId = version2;
    context.appsProviderId = 'notion';
    context.exports[name]()({ type: 'click' });
    assert.equal(context.appsShareId, undefined);
    assert.equal(context.exports.AppsDialog_initialProviderId(), undefined);
  }
  context.exports.AgentDialog_onSharedApps()();
  assert.equal(context.appsShareId, version2);
  const before = opened.length;
  active = false;
  context.appsProviderId = 'github';
  context.exports.AppActionCard_onApps()(ids.share);
  assert.equal(opened.length, before);
  assert.equal(context.appsShareId, version2);
  assert.equal(context.exports.AppsDialog_initialProviderId(), 'github');
});

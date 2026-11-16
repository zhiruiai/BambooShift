import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { Message } from '../../shared/types';
import { all, compile, deferred, harness, json, render } from './testSupport/appsFixture';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
const assignmentRevision = '33333333-3333-4333-8333-333333333333';
const action = {
  id: 'action-a',
  agentId: 'bot-a',
  type: 'browser_click',
  status: 'pending',
  createdAt: '2026-11-07T10:00:00Z',
  payload: { type: 'browser_click', selector: '#publish' },
  requester: { userId: 'member-a', name: 'Reader' },
  screenBinding: { screenId: 'screen-a', assignmentRevision },
};
const message = (value: Record<string, unknown> = action): Message => ({
  id: 'message-a',
  conversationId: 'conversation-a',
  agentId: 'bot-a',
  role: 'assistant',
  kind: 'computer',
  status: 'done',
  createdAt: '2026-11-07T10:00:00Z',
  content: '电脑操作等待发起人批准。',
  metadata: { action: value },
});
function environment(locale = 'zh-CN') {
  return {
    Event,
    window: Object.assign(new EventTarget(), {
      location: { pathname: `/w/${workspaceId}/` },
      localStorage: { getItem: () => JSON.stringify({ version: 1, locale }) },
    }),
  };
}

async function open(
  transport: typeof fetch,
  overrides: Record<string, unknown> = {},
  env = environment(),
) {
  const ui = await harness(
    'web/src/components/ChatComputerCard.tsx',
    'ApprovalHarness',
    {
      message: message(),
      workspaceId,
      userId: 'member-a',
      owner: false,
      onChanged: async () => {},
      onOpenCurrentComputer() {},
      ...overrides,
    },
    transport,
    env,
    '\nfunction ApprovalHarness(props: any) { return ComputerRecord(props); }',
  );
  await ui.flush();
  return { ui, env };
}

test('chat computer approval shows bilingual inline decisions and posts exactly the reviewed request once', async () => {
  for (const locale of ['zh-CN', 'en']) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const pending = deferred<Response>();
    let changed = 0;
    const { ui } = await open(
      (async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return init?.method === 'GET' ? json([action]) : pending.promise;
      }) as typeof fetch,
      {
        onChanged: async () => {
          changed++;
        },
      },
      environment(locale),
    );
    try {
      assert.equal(calls.length, 0, 'rendering a card never performs a decision');
      const allow = ui.button(locale === 'en' ? 'Allow once' : '允许一次').props.onClick;
      assert.ok(ui.button(locale === 'en' ? 'Deny' : '拒绝'));
      allow();
      allow();
      await ui.flush();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, `/api/workspaces/${workspaceId}/computer/bots/bot-a/actions`);
      assert.equal(calls[1].url, `${calls[0].url}/action-a/approve`);
      assert.equal(calls[1].init.method, 'POST');
      assert.equal(calls[1].init.body, undefined);
      assert.equal(
        (calls[1].init.headers as Record<string, string>)['X-OpenBot-Expected-User'],
        'member-a',
      );
      pending.resolve(json({ ...action, status: 'running' }));
      await ui.flush();
      allow();
      await ui.flush();
      assert.equal(calls.length, 2);
      assert.equal(changed, 1);
      assert.equal(ui.maybeButton(locale === 'en' ? 'Allow once' : '允许一次'), undefined);
      assert.match(ui.copy, locale === 'en' ? /In progress/ : /进行中/);
    } finally {
      pending.resolve(json(action));
      ui.dispose();
    }
  }
});

test('only the requester or the legacy owner can decide, and file decisions keep the machine route', async () => {
  for (const [requester, userId, owner, permitted] of [
    [action.requester, 'member-a', false, true],
    [action.requester, 'owner-b', true, false],
    [undefined, 'owner-b', true, true],
    [undefined, 'member-a', false, false],
    [null, 'owner-b', true, false],
  ] as const) {
    const file = {
      ...action,
      type: 'upload_file',
      requester,
      payload: { fileId: 'file-a', path: 'report.txt' },
    };
    const calls: string[] = [];
    const { ui } = await open(
      (async (url, init) => {
        calls.push(String(url));
        return json(init?.method === 'GET' ? [file] : { ...file, status: 'rejected' });
      }) as typeof fetch,
      { message: message(file), userId, owner },
    );
    try {
      assert.equal(!!ui.maybeButton('拒绝'), permitted);
      if (permitted) {
        ui.button('拒绝').props.onClick();
        await ui.flush();
        assert.deepEqual(calls, [
          `/api/workspaces/${workspaceId}/computer/actions`,
          `/api/workspaces/${workspaceId}/computer/actions/action-a/reject`,
        ]);
      } else assert.deepEqual(calls, []);
    } finally {
      ui.dispose();
    }
  }
});

test('deferred preflight cannot approve after account, route, request, status, expiry or lifetime changes', async () => {
  for (const change of ['account', 'workspace', 'route', 'request', 'status', 'auth', 'unmount']) {
    const pending = deferred<Response>();
    const calls: string[] = [];
    const { ui, env } = await open((async (url) => {
      calls.push(String(url));
      return pending.promise;
    }) as typeof fetch);
    try {
      const allow = ui.button('允许一次').props.onClick;
      allow();
      await ui.flush();
      assert.equal(calls.length, 1);
      if (change === 'account') ui.setProps({ userId: 'other-person' });
      if (change === 'workspace') ui.setProps({ workspaceId: otherWorkspace });
      if (change === 'route') env.window.location.pathname = `/w/${otherWorkspace}/`;
      if (change === 'request')
        ui.setProps({ message: message({ ...action, payload: { selector: '#delete' } }) });
      if (change === 'status') ui.setProps({ message: message({ ...action, status: 'rejected' }) });
      if (change === 'auth') env.window.dispatchEvent(new Event('openbot:account-expired'));
      if (change === 'unmount') ui.dispose();
      if (change !== 'unmount') await ui.flush();
      pending.resolve(json([action]));
      await ui.flush();
      allow();
      await ui.flush();
      assert.equal(calls.length, 1, change);
    } finally {
      pending.resolve(json([action]));
      ui.dispose();
    }
  }
});

test('authoritative changed or missing requests never dispatch, and completed requests update the card', async () => {
  for (const kind of ['changed', 'missing', 'done']) {
    const calls: string[] = [];
    const found =
      kind === 'missing'
        ? []
        : [
            {
              ...action,
              ...(kind === 'changed'
                ? { screenBinding: { screenId: 'other', assignmentRevision: 'new' } }
                : { status: 'done' }),
            },
          ];
    const { ui } = await open((async (url) => {
      calls.push(String(url));
      return json(found);
    }) as typeof fetch);
    try {
      ui.button('允许一次').props.onClick();
      await ui.flush();
      assert.equal(calls.length, 1);
      if (kind === 'done') assert.equal(ui.maybeButton('允许一次'), undefined);
      else assert.match(ui.copy, kind === 'changed' ? /请求已变化/ : /记录已失效/);
    } finally {
      ui.dispose();
    }
  }
});

test('lost decision receipts remain locked until an explicit read resolves the current action', async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  let stored = { ...action };
  const { ui } = await open((async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (init?.method === 'POST') {
      stored = { ...action, status: 'running' };
      throw new TypeError('connection lost after accepted');
    }
    return json([stored]);
  }) as typeof fetch);
  try {
    const allow = ui.button('允许一次').props.onClick;
    allow();
    await ui.flush();
    assert.equal(ui.button('允许一次').props.disabled, true);
    assert.match(ui.copy, /尚未确认本次选择/);
    allow();
    await ui.flush();
    assert.equal(calls.length, 2);
    ui.button('刷新审批状态').props.onClick();
    await ui.flush();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].method, 'GET');
    assert.equal(ui.maybeButton('允许一次'), undefined);
  } finally {
    ui.dispose();
  }
});

test('unreadable shell requests can be denied but never allowed', async () => {
  const { ui } = await open((async () => json([])) as typeof fetch, {
    message: message({ ...action, type: 'remote_shell', payload: {} }),
  });
  try {
    assert.equal(ui.button('允许一次').props.disabled, true);
    assert.equal(ui.button('拒绝').props.disabled, false);
  } finally {
    ui.dispose();
  }
});

test('pending cards expose the exact typed text and full address for review without interpreting them', async () => {
  const payload = {
    selector: '#input',
    text: '<script>literal input</script>',
    url: 'https://example.com/submit?draft=42',
  };
  const { ui } = await open((async () => json([])) as typeof fetch, {
    message: message({ ...action, type: 'browser_type', payload }),
  });
  try {
    assert.match(ui.copy, /本次操作详情/);
    assert.ok(ui.copy.includes(payload.text));
    assert.ok(ui.copy.includes(payload.url));
    assert.ok(ui.button('允许一次'));
  } finally {
    ui.dispose();
  }
});

test('Mac approval shows the trusted control without leaking snapshot identifiers', async () => {
  const payload = { snapshotToken: 'private-snapshot-token', elementId: 'opaque-control-id' };
  const target = { app: 'Calculator', role: 'AXButton', label: 'Clear', windowTitle: 'Basic' };
  for (const approvedTarget of [target, undefined]) {
    const { ui } = await open(
      (async () => json([])) as typeof fetch,
      {
        message: message({ ...action, type: 'desktop_ax_press', payload, target: approvedTarget }),
      },
      environment('en'),
    );
    try {
      assert.match(ui.copy, /Click Mac app control/);
      assert.doesNotMatch(ui.copy, /private-snapshot-token|opaque-control-id/);
      assert.equal(ui.button('Allow once').props.disabled, !approvedTarget);
      if (approvedTarget) assert.match(ui.copy, /Calculator · Basic · Clear/);
      else assert.match(ui.copy, /inspect the app again/);
    } finally {
      ui.dispose();
    }
  }
});

test('Mac text replacement shows exact text and its window before approval', async () => {
  const text = '  第一行 <strong>\nsecond line  ';
  const target = { app: 'TextEdit', windowTitle: 'Draft', role: 'AXTextArea', label: 'Document' };
  const replacement = {
    ...action,
    type: 'desktop_ax_set_text',
    target,
    payload: { text, snapshotToken: 'private-snapshot-token', elementId: 'opaque-control-id' },
  };
  const transport = (async () => json([])) as typeof fetch;
  for (const record of [replacement, { ...replacement, target: undefined }]) {
    const { ui } = await open(transport, { message: message(record) }, environment('en'));
    try {
      assert.match(ui.copy, /Replace text in Mac app/);
      assert.doesNotMatch(ui.copy, /private-snapshot-token|opaque-control-id/);
      assert.equal(ui.button('Allow once').props.disabled, !record.target);
      if (record.target) assert.match(ui.copy, /TextEdit · Draft · Document/);
      const [details] = all(ui.tree, (node) => node.type === 'details' && node.props.open);
      assert.ok(all(details, (node) => node.type === 'pre' && node.props.children === text).length);
    } finally {
      ui.dispose();
    }
  }

  const { ui: receipt } = await open(
    transport,
    { message: message({ ...replacement, status: 'done', result: { ok: true } }) },
    environment('en'),
  );
  try {
    const [details] = all(receipt.tree, (node) => node.type === 'details' && !node.props.open);
    assert.ok(details, 'completed receipt should start collapsed');
    assert.ok(all(details, (node) => node.type === 'pre' && node.props.children === text).length);
    assert.equal(receipt.maybeButton('Allow once'), undefined);
  } finally {
    receipt.dispose();
  }

  const dialog = await compile(
    'web/src/components/computer/ComputerActionEntry.tsx',
    '',
    environment('en'),
  );
  const html = render(dialog.ComputerActionEntry, {
    action: replacement,
    owner: false,
    userId: 'member-a',
    busy: false,
    controlled: false,
    onApprove() {},
    onReject() {},
  });
  assert.match(html, /TextEdit · Draft · Document/);
  assert.match(html, /<details[^>]* open="">/);
  assert.ok(html.includes('  第一行 &lt;strong&gt;\nsecond line  '));
  assert.doesNotMatch(html, /private-snapshot-token|opaque-control-id/);
});

test('read-only actions can start without presenting approval or premature result controls', async () => {
  const calls: string[] = [];
  for (const type of [
    'list_files',
    'read_file',
    'download_file',
    'terminal_command',
    'browser_screenshot',
    'desktop_screenshot',
  ]) {
    const { ui } = await open(
      (async (url) => {
        calls.push(String(url));
        return json([]);
      }) as typeof fetch,
      { message: message({ ...action, type, result: { title: 'Unconfirmed result' } }) },
      environment('en'),
    );
    try {
      assert.match(ui.copy, /Starting/);
      assert.doesNotMatch(ui.copy, /Waiting for|Unconfirmed result/);
      assert.equal(ui.maybeButton('Allow once'), undefined);
      assert.equal(ui.maybeButton('Deny'), undefined);
      assert.ok(ui.button('Open current computer'));
    } finally {
      ui.dispose();
    }
  }
  assert.deepEqual(calls, []);
});

test('receipts expose a screen assignment only when it belongs to the recorded action', async () => {
  for (const [record, assigned] of [
    [{ ...action }, true],
    [{ ...action, agentId: 'other-bot' }, false],
    [{ ...action, conversationId: 'other-chat' }, false],
    [{ ...action, screenBinding: { screenId: 'screen-a' } }, false],
    [{ ...action, screenBinding: { screenId: 'screen-a', assignmentRevision: 'invalid' } }, false],
    [{ ...action, screenBinding: undefined, executionLocation: 'cloud' }, false],
  ] as const) {
    const { ui } = await open(
      (async () => json([])) as typeof fetch,
      { message: message({ ...record, status: 'done', result: { ok: true } }) },
      environment('en'),
    );
    try {
      assert.match(ui.copy, /Completed/);
      assert.equal(ui.copy.includes('Assigned Bot screen'), assigned);
      assert.doesNotMatch(ui.copy, /screen-a|cloud|Watching|Take control|Result/);
      assert.ok(!ui.copy.includes(assignmentRevision));
      assert.ok(ui.button('Open current computer'));
    } finally {
      ui.dispose();
    }
  }
});

test('a receipt keeps its recorded execution location and opens the current computer explicitly', async () => {
  const targetRevision = '44444444-4444-4444-8444-444444444444';
  for (const [locale, location, origin] of [
    ['zh-CN', 'remote', /已配对的 Mac · Mac 应用/],
    ['en', 'remote', /Paired Mac · Mac apps/],
    ['zh-CN', 'server', /这台 Mac · Mac 应用/],
    ['en', 'server', /This Mac · Mac apps/],
  ] as const) {
    let currentComputer = 'original computer';
    let opened = '';
    const { ui } = await open(
      (async () => json([])) as typeof fetch,
      {
        message: message({
          ...action,
          type: 'desktop_ax_press',
          status: 'done',
          result: { text: 'Pressed Clear' },
          execution: { location, surface: 'accessibility', targetRevision },
          screenBinding: undefined,
        }),
        onOpenCurrentComputer: () => {
          opened = currentComputer;
        },
      },
      environment(locale),
    );
    try {
      assert.match(ui.copy, origin);
      assert.match(ui.copy, /Pressed Clear/);
      assert.ok(!ui.copy.includes(targetRevision));
      currentComputer = 'replacement computer';
      ui.button(locale === 'en' ? 'Open current computer' : '打开当前电脑').props.onClick();
      assert.equal(opened, 'replacement computer');
      assert.match(ui.copy, origin);
    } finally {
      ui.dispose();
    }
  }
});

test('completed receipts show real output and a single file card with a workspace-scoped download', async () => {
  const { AccountContext, ComputerRecord } = await compile(
    'web/src/components/ChatComputerCard.tsx',
    "\nexport { AccountContext } from '../AccountContext';",
    environment('en'),
  );
  const web = render(ComputerRecord, {
    message: message({
      ...action,
      type: 'browser_navigate',
      status: 'done',
      payload: { url: 'https://example.test/start?private=1' },
      result: {
        title: 'Public results',
        url: 'https://example.test/result?private=2',
        text: 'The page returned a real result.',
      },
    }),
  });
  assert.match(web, /Public results/);
  assert.match(web, /The page returned a real result/);
  assert.match(web, /https:\/\/example\.test\/result/);
  assert.doesNotMatch(web, /private=|电脑操作等待发起人批准/);

  const file = render(AccountContext.Provider, {
    value: { session: { user: { id: 'member-a' } }, workspace: { id: workspaceId } },
    children: createElement(ComputerRecord, {
      message: message({
        ...action,
        type: 'download_file',
        status: 'done',
        payload: { path: 'example/report.md' },
        result: {
          fileId: 'synthetic-file',
          path: 'example/report.md',
          name: 'report.md',
          size: 18,
        },
      }),
    }),
  });
  assert.equal(file.match(/example\/report\.md/g)?.length, 1);
  assert.match(file, new RegExp(`/api/workspaces/${workspaceId}/files/synthetic-file/download`));
  assert.match(file, /aria-label="Preview report\.md"/);
});

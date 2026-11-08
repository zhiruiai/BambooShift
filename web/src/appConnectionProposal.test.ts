import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../shared/types';
import { parseAppConnectionProposal } from '../../shared/app-proposals';
import { createWorkspaceDialogs } from './workspace/createWorkspaceDialogs';
import { all, compile, deferred, harness, json, props, render } from './testSupport/appsFixture';

const message: Message = {
  id: 'proposal-a',
  conversationId: 'chat-a',
  agentId: 'bot-a',
  role: 'assistant',
  kind: 'app_connection_proposal',
  status: 'done',
  createdAt: '2026-11-05T09:00:00Z',
  content: '整理项目资料',
  metadata: {
    appConnectionProposal: {
      providerId: 'notion',
      reason: '整理项目资料',
      runId: 'run-a',
      toolCallId: 'call-a',
      requester: { userId: 'owner-a', messageId: 'input-a' },
    },
  },
};
const cardProps = () => ({
  message: structuredClone(message),
  workspaceId: 'space-a',
  userId: 'owner-a',
  owner: true,
  localBotAvailable: true,
  onOpen: (_provider: string, _agent: string) => {},
});
const snapshot = () => ({
  messages: [structuredClone(message)],
  agents: [{ id: 'bot-a' }],
  conversations: [{ id: 'chat-a', agentIds: ['bot-a'] }],
});
const session = () => ({
  authenticated: true,
  user: { id: 'owner-a', status: 'active' },
  workspaces: [{ id: 'space-a', role: 'owner', status: 'active' }],
});
function environment(locale = 'zh-CN') {
  return {
    window: Object.assign(new EventTarget(), {
      location: { pathname: '/w/space-a' },
      localStorage: { getItem: () => JSON.stringify({ version: 1, locale }) },
    }),
    Event,
  };
}
const cardFile = 'web/src/components/AppConnectionProposalCard.tsx';
async function card(
  initial = cardProps(),
  transport: typeof fetch = async () => json({}),
  env = environment(),
) {
  return harness(cardFile, 'AppConnectionProposalContent', initial, transport, env);
}

test('proposal parsing requires the dedicated assistant card and bounded trusted provider metadata', () => {
  assert.equal(parseAppConnectionProposal(message)?.providerId, 'notion');
  const mutate = (change: (value: any) => void) => {
    const value = structuredClone(message);
    change(value);
    assert.equal(parseAppConnectionProposal(value), undefined);
  };
  mutate((value) => {
    value.role = 'user';
  });
  mutate((value) => {
    value.kind = 'text';
  });
  mutate((value) => {
    value.status = 'streaming';
  });
  mutate((value) => {
    value.metadata.appConnectionProposal.providerId = 'unlisted';
  });
  mutate((value) => {
    value.metadata.appConnectionProposal.url = 'https://untrusted.example.test';
  });
  mutate((value) => {
    value.metadata.appConnectionProposal.reason = 'x'.repeat(301);
  });
  mutate((value) => {
    delete value.metadata.appConnectionProposal.requester.messageId;
  });
  mutate((value) => {
    value.metadata.appConnectionProposal.requester.owner = true;
  });
});

test('actual card reads fixed owner and authoritative card before opening only the existing provider form', async () => {
  const opened: string[][] = [],
    calls: Array<{ path: string; init: RequestInit }> = [];
  const h = await card(
    { ...cardProps(), onOpen: (provider, agent) => opened.push([provider, agent]) },
    async (path, init) => {
      calls.push({ path: String(path), init: init! });
      return json(String(path) === '/api/account/session' ? session() : snapshot());
    },
  );
  try {
    await h.flush();
    assert.equal(calls.length, 0);
    const click = h.button('核对并连接').props.onClick;
    click();
    click();
    await h.flush();
    assert.deepEqual(opened, [['notion', 'bot-a']]);
    assert.deepEqual(
      calls.map((call) => call.path),
      ['/api/account/session', '/api/workspaces/space-a/bootstrap'],
    );
    for (const call of calls) {
      assert.equal(call.init.method, 'GET');
      assert.equal(new Headers(call.init.headers).get('X-OpenBot-Expected-User'), 'owner-a');
      assert.equal(call.init.body, undefined);
    }
  } finally {
    h.dispose();
  }
});

test('member, another requester, shared or missing Bot cannot use a retained click callback', async () => {
  for (const update of [{ owner: false }, { userId: 'member-b' }, { localBotAvailable: false }]) {
    let calls = 0;
    const h = await card(cardProps(), async () => {
      calls++;
      return json({});
    });
    try {
      await h.flush();
      const click = h.button('核对并连接').props.onClick;
      h.setProps(update);
      await h.flush();
      click();
      await h.flush();
      assert.equal(calls, 0);
      assert.equal(h.button('核对并连接').props.disabled, true);
    } finally {
      h.dispose();
    }
  }
});

test('fresh ownership and Bot/card checks reject revoked rights, deleted Bots and modified cards', async () => {
  for (const scenario of ['member', 'deleted', 'shared', 'changed'] as const) {
    let opened = 0;
    const h = await card(
      {
        ...cardProps(),
        onOpen: () => {
          opened++;
        },
      },
      async (path) => {
        if (String(path) === '/api/account/session') {
          const value = session();
          if (scenario === 'member') value.workspaces[0].role = 'member';
          return json(value);
        }
        const value: any = snapshot();
        if (scenario === 'deleted') value.agents = [];
        if (scenario === 'shared') value.agents[0].sharedBot = { shareId: 'share-a' };
        if (scenario === 'changed')
          value.messages[0].metadata.appConnectionProposal.providerId = 'github';
        return json(value);
      },
    );
    try {
      await h.flush();
      h.button('核对并连接').props.onClick();
      await h.flush();
      assert.equal(opened, 0);
      assert.match(h.copy, /这项建议当前不可用/);
    } finally {
      h.dispose();
    }
  }
});

test('account, workspace, navigation and unmount invalidate a pending owner read even if abort is ignored', async () => {
  for (const change of ['account', 'workspace', 'path', 'unmount'] as const) {
    const gate = deferred<Response>(),
      env = environment();
    let calls = 0,
      opened = 0;
    const h = await card(
      {
        ...cardProps(),
        onOpen: () => {
          opened++;
        },
      },
      async () => {
        calls++;
        return gate.promise;
      },
      env,
    );
    try {
      await h.flush();
      h.button('核对并连接').props.onClick();
      await h.flush();
      if (change === 'account') h.setProps({ userId: 'owner-b' });
      if (change === 'workspace') h.setProps({ workspaceId: 'space-b' });
      if (change === 'path') env.window.location.pathname = '/w/space-b';
      if (change === 'unmount') h.dispose();
      await h.flush();
      gate.resolve(json(session()));
      await h.flush();
      assert.equal(calls, 1);
      assert.equal(opened, 0);
    } finally {
      h.dispose();
    }
  }
});

test('a late bootstrap cannot open a stale proposal after Bot removal or account change', async () => {
  for (const update of [{ localBotAvailable: false }, { userId: 'owner-b' }]) {
    const gate = deferred<Response>();
    let opened = 0;
    const h = await card(
      {
        ...cardProps(),
        onOpen: () => {
          opened++;
        },
      },
      async (path) => (String(path) === '/api/account/session' ? json(session()) : gate.promise),
    );
    try {
      await h.flush();
      h.button('核对并连接').props.onClick();
      await h.flush();
      h.setProps(update);
      await h.flush();
      gate.resolve(json(snapshot()));
      await h.flush();
      assert.equal(opened, 0);
    } finally {
      h.dispose();
    }
  }
});

test('provider opening pre-fills the actual add form without credentials, sharing consent or network creation', async () => {
  const calls: RequestInit[] = [];
  const h = await harness(
    'web/src/components/AppsDialog.tsx',
    'AppsDialogContent',
    { ...props(), initialProviderId: 'github' },
    async (_path, init) => {
      calls.push(init!);
      return json([]);
    },
  );
  try {
    await h.flush();
    const inputs = all(h.tree, (node) => node.type === 'input');
    assert.ok(
      inputs.some((node) => node.props.value === 'https://api.githubcopilot.com/mcp/readonly'),
    );
    assert.equal(inputs.find((node) => node.props.type === 'password').props.value, '');
    assert.equal(inputs.find((node) => node.props.type === 'checkbox').props.checked, false);
    inputs
      .find((node) => node.props.value === 'GitHub')
      .props.onChange({ target: { value: 'Reviewed connection name' } });
    await h.flush();
    h.setProps({ initialProviderId: 'notion' });
    await h.flush();
    assert.ok(
      all(h.tree, (node) => node.type === 'input').some(
        (node) => node.props.value === 'Reviewed connection name',
      ),
    );
    assert.ok(calls.every((call) => call.method === 'GET'));
  } finally {
    h.dispose();
  }
});

test('proposal labels are bilingual while user-facing model reason remains unchanged', async () => {
  for (const [locale, title, button] of [
    ['zh-CN', '建议连接 Notion', '核对并连接'],
    ['en', 'Suggested connection: Notion', 'Review and connect'],
  ]) {
    const module = await compile(cardFile, '', environment(locale));
    const html = render(module.AppConnectionProposalCard, cardProps());
    assert.ok(html.includes(title));
    assert.ok(html.includes(button));
    assert.ok(html.includes('整理项目资料'));
    assert.ok(!html.includes('href='));
  }
});

test('workspace opening preserves another dialog and validates current scope and live local Bot', () => {
  const opened: string[] = [],
    providers: string[] = [];
  let active = true;
  const state: any = {
    modal: null,
    canManage: true,
    data: snapshot(),
    sendScope: { ticket: () => 0, current: () => active },
    setAppsProviderId: (id: string) => providers.push(id),
    setAppsCustomProposal() {},
    setAppsShareId() {},
    setModal: (value: string) => opened.push(value),
  };
  const { openAppProposal } = createWorkspaceDialogs(() => state);
  state.modal = 'settings';
  openAppProposal('notion', 'bot-a');
  state.modal = null;
  state.canManage = false;
  openAppProposal('notion', 'bot-a');
  state.canManage = true;
  active = false;
  openAppProposal('notion', 'bot-a');
  active = true;
  openAppProposal('arbitrary', 'bot-a');
  openAppProposal('notion', 'deleted');
  state.data.agents[0].sharedBot = {};
  openAppProposal('notion', 'bot-a');
  assert.equal(opened.length, 0);
  assert.equal(providers.length, 0);
  delete state.data.agents[0].sharedBot;
  openAppProposal('notion', 'bot-a');
  assert.deepEqual(opened, ['apps']);
  assert.deepEqual(providers, ['notion']);
});

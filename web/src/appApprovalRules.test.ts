import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppAction, AppApprovalRule } from '../../shared/app-connections';
import {
  appApprovalReview,
  exactAppApprovalInput,
  parseAppApprovalRules,
} from './appApprovalRules';
import { createAppConnectionScope } from './appConnections';
import { action, all, harness, json } from './testSupport/appsFixture';

const ruleId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'approval-space';
const userId = 'requesting-owner';
const input = { method: 'get', owner: 'fixture-org', repo: 'test-repo', issue_number: 17 } as const;
const labels = { agentName: '调研助手', conversationTitle: '议题跟进' };
const pending: AppAction = {
  ...action,
  appName: 'GitHub',
  toolName: 'issue_read',
  requester: { userId },
  arguments: input,
  interactiveApproval: { eligible: true, ...labels },
};
const receipt = (usage: 'saved' | 'reused'): AppAction => ({
  ...pending,
  status: 'done',
  interactiveApproval: { eligible: false, ruleId, usage, ...labels },
});
const rule: AppApprovalRule = {
  id: ruleId,
  agentId: pending.agentId,
  conversationId: pending.conversationId,
  connectionId: pending.connectionId,
  connectionName: pending.appName,
  toolName: pending.toolName,
  input,
  createdAt: pending.createdAt,
  ...labels,
};

const uiForAction = (transport: typeof fetch) =>
  harness(
    'web/src/components/AppActionCard.tsx',
    'AppActionContent',
    { action: pending, workspaceId, userId, owner: true, onChanged: async () => {}, onApps() {} },
    transport,
  );

test('exact permissions require one trusted issue read and valid per-workspace rules', () => {
  const actor = { userId, owner: true };
  assert.deepEqual(appApprovalReview(pending, actor)?.scope.input, input);
  assert.equal(appApprovalReview(pending, { ...actor, owner: false }), undefined);
  assert.equal(appApprovalReview({ ...pending, toolName: 'issue_write' }, actor), undefined);
  assert.equal(appApprovalReview({ ...pending, requester: undefined }, actor), undefined);
  assert.equal(exactAppApprovalInput({ ...input, method: 'get_comments' }), undefined);
  assert.equal(exactAppApprovalInput({ ...input, hidden: true }), undefined);
  assert.equal(exactAppApprovalInput({ ...input, repo: '..' }), undefined);
  assert.deepEqual(parseAppApprovalRules({ rules: [rule] }), [rule]);
  assert.equal(parseAppApprovalRules({ rules: [rule, rule] }), undefined);
  assert.equal(parseAppApprovalRules({ rules: [{ ...rule, id: 'arbitrary-path' }] }), undefined);
});

test('the real card shows exact scope before POST and distinguishes saved and reused receipts', async () => {
  for (const usage of ['saved', 'reused'] as const) {
    const requests: [string, RequestInit][] = [];
    const ui = await uiForAction(async (url, options) => {
      requests.push([String(url), options!]);
      return json(receipt(usage));
    });
    try {
      await ui.flush();
      ui.button('始终允许').props.onClick();
      await ui.flush();
      assert.equal(requests.length, 0);
      assert.match(ui.copy, /允许此会话再次执行这项读取/);
      const details = all(ui.tree, (node) => node.type?.name === 'ExactApprovalDetails')[0];
      assert.deepEqual(JSON.parse(JSON.stringify(details.props.scope)), {
        ...labels,
        connectionName: 'GitHub',
        toolName: 'issue_read',
        input,
      });
      const confirm = ui.button('保存并允许').props.onClick;
      confirm();
      confirm();
      await ui.flush();
      assert.equal(requests.length, 1);
      assert.equal(
        requests[0][0],
        `/api/workspaces/${workspaceId}/app-actions/${pending.id}/decision`,
      );
      assert.equal(requests[0][1].method, 'POST');
      assert.equal(new Headers(requests[0][1].headers).get('X-OpenBot-Expected-User'), userId);
      assert.deepEqual(JSON.parse(String(requests[0][1].body)), { decision: 'always_allow' });
      assert.match(ui.copy, usage === 'saved' ? /已保存精确授权/ : /已使用已保存的授权/);
    } finally {
      ui.dispose();
    }
  }
});

test('scope drift or cancellation invalidates retained confirm callbacks', async () => {
  for (const change of ['arguments', 'owner', 'cancel'] as const) {
    let posts = 0;
    const ui = await uiForAction(async () => {
      posts++;
      return json(receipt('saved'));
    });
    try {
      await ui.flush();
      ui.button('始终允许').props.onClick();
      await ui.flush();
      const confirm = ui.button('保存并允许').props.onClick;
      if (change === 'arguments')
        ui.setProps({ action: { ...pending, arguments: { ...input, issue_number: 18 } } });
      if (change === 'owner') ui.setProps({ owner: false });
      if (change === 'cancel') ui.button('取消').props.onClick();
      await ui.flush();
      confirm();
      await ui.flush();
      assert.equal(posts, 0, change);
      assert.equal(ui.button('批准这一次').props.disabled, false);
    } finally {
      ui.dispose();
    }
  }
});

test('definite conflicts enable one-time approval and uncertain writes only expose status refresh', async () => {
  for (const failure of ['APP_APPROVAL_RULE_CHANGED', 'APP_APPROVAL_RULE_LIMIT', 'unconfirmed']) {
    const decisions: unknown[] = [];
    const ui = await uiForAction(async (url, options) => {
      if (String(url).endsWith('/bootstrap'))
        return json({ messages: [{ metadata: { appAction: receipt('saved') } }] });
      const body = JSON.parse(String(options?.body));
      decisions.push(body);
      if (body.approve === true) return json({ ...pending, status: 'done' });
      return failure === 'unconfirmed'
        ? json({ error: 'Unconfirmed response' }, 503)
        : json({ code: failure }, 409);
    });
    try {
      await ui.flush();
      ui.button('始终允许').props.onClick();
      await ui.flush();
      ui.button('保存并允许').props.onClick();
      await ui.flush();
      const once = ui.button('批准这一次');
      if (failure === 'unconfirmed') {
        assert.equal(once.props.disabled, true);
        once.props.onClick();
        await ui.flush();
        assert.equal(decisions.length, 1);
        ui.button('刷新状态').props.onClick();
        await ui.flush();
        assert.match(ui.copy, /已保存精确授权/);
      } else {
        assert.equal(once.props.disabled, false);
        assert.equal(ui.maybeButton('始终允许'), undefined);
        once.props.onClick();
        await ui.flush();
        assert.deepEqual(decisions, [{ decision: 'always_allow' }, { approve: true }]);
      }
    } finally {
      ui.dispose();
    }
  }
});

test('saved permissions use the captured actor and reconcile an unknown revoke without retrying', async () => {
  const identity = { workspaceId, userId };
  const calls: [string, string | undefined][] = [];
  let saved = true;
  let changed = 0;
  const scope = createAppConnectionScope({
    ...identity,
    identity: () => identity,
    fetch: async (path, options) => {
      assert.equal(new Headers(options?.headers).get('X-OpenBot-Expected-User'), userId);
      calls.push([String(path), options?.method]);
      if (options?.method === 'DELETE') {
        saved = false;
        return json({}, 503);
      }
      return json({ rules: saved ? [rule] : [] });
    },
  });
  const ui = await harness(
    'web/src/components/apps/AppApprovalRulesPanel.tsx',
    'RulesHarness',
    {
      scope,
      onBusyChange() {},
      onChanged() {
        changed++;
      },
    },
    fetch,
    {},
    '\nfunction RulesHarness(props: any) { return AppApprovalRulesPanel(props); }',
  );
  const root = `/api/workspaces/${workspaceId}/apps/approval-rules`;
  try {
    await ui.flush();
    const revoke = ui.button('撤销').props.onClick;
    revoke();
    await ui.flush();
    assert.match(ui.copy, /暂未确认是否撤销/);
    revoke();
    await ui.flush();
    assert.deepEqual(calls, [
      [root, 'GET'],
      [`${root}/${ruleId}`, 'DELETE'],
    ]);
    ui.button('刷新权限').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /还没有已保存的应用权限/);
    assert.equal(changed, 0);
    assert.deepEqual(calls.at(-1), [root, 'GET']);
    identity.userId = 'another-owner';
    revoke();
    await ui.flush();
    assert.equal(calls.length, 3);
  } finally {
    scope.suspend();
    ui.dispose();
  }
});

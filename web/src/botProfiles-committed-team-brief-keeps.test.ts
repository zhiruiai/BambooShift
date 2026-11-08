import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import type { BotAgent } from '../../shared/types';
import type { BotTeamPlan, BotTeamProposalCard as Proposal } from '../../shared/bot-team-plans';
import { webcrypto } from 'node:crypto';
import {
  compile,
  render,
  json,
  deferred,
  text,
  all,
  harness,
  agent,
  other,
  team,
  environment,
  teamProps,
  teamBootstrap,
  proposal,
  committedTeam,
  cardProps,
} from './testSupport/botProfilesFixture';

test('actual committed team brief keeps goal and assignments visible, follows current leader and excludes removed members as escaped text', async () => {
  const { BotTeamBrief } = await compile('web/src/components/BotTeamBrief.tsx');
  const html = render(BotTeamBrief, {
    conversation: {
      id: 'group-a',
      isGroup: true,
      agentIds: ['bot-b', 'bot-a'],
      teamBrief: {
        goal: '<script>goal</script>',
        summary: '先研究再汇总',
        leadAgentId: 'removed',
        assignments: [
          { agentId: 'bot-a', assignment: '协调' },
          { agentId: 'bot-b', assignment: '<img>研究' },
          { agentId: 'removed', assignment: '过期分工' },
        ],
      },
    },
    agents: [agent, other],
  });
  assert.match(html, /小叶<span>负责人/);
  assert.match(html, /协调/);
  assert.match(html, /&lt;img&gt;研究/);
  assert.match(html, /&lt;script&gt;goal/);
  assert.doesNotMatch(html, /过期分工|<script>|<img>/);
});

test('actual editable team draft persists through revise and reopens with the new revision, while reads never silently rebase local edits', async () => {
  const env = environment(),
    writes: any[] = [];
  let stored = structuredClone(team);
  const transport = (async (url: any, init: any) => {
    if (init.method === 'GET')
      return json(String(url).endsWith('/bot-team-plans') ? [stored] : stored);
    const body = JSON.parse(init.body);
    writes.push(body);
    stored = { ...stored, revision: `saved-${writes.length}`, draft: body.draft };
    return json(stored);
  }) as typeof fetch;
  const first = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    teamProps(),
    transport,
    env,
  );
  try {
    await first.flush();
    first.button('发布协作组待确认').props.onClick();
    await first.flush();
    first.field('群聊名称').props.onChange({ target: { value: '持久编辑稿' } });
    await first.flush();
    first.button('保存草稿').props.onClick();
    await first.flush();
    assert.match(first.copy, /草稿已保存/);
    assert.equal(first.button('保存草稿').props.disabled, true);
    assert.equal(stored.draft?.title, '持久编辑稿');
    assert.equal(writes[0].expectedRevision, team.revision);
  } finally {
    first.dispose();
  }
  const second = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    teamProps(),
    transport,
    env,
  );
  try {
    await second.flush();
    second.button('持久编辑稿待确认').props.onClick();
    await second.flush();
    assert.equal(second.field('群聊名称').props.value, '持久编辑稿');
    second.field('群聊名称').props.onChange({ target: { value: '本窗口未保存草稿' } });
    await second.flush();
    stored = {
      ...stored,
      revision: 'other-window-revision',
      draft: { ...stored.draft!, title: '另一窗口方案' },
    };
    second.button('检查状态').props.onClick();
    await second.flush();
    assert.equal(second.field('群聊名称').props.value, '本窗口未保存草稿');
    assert.equal(second.button('确认创建协作团队').props.disabled, true);
    second.button('确认创建协作团队').props.onClick();
    await second.flush();
    assert.equal(writes.length, 1);
    second.button('继续编辑方案').props.onClick();
    await second.flush();
    assert.equal(writes[1].expectedRevision, 'other-window-revision');
    assert.equal(stored.draft?.title, '本窗口未保存草稿');
    assert.equal(second.button('确认创建协作团队').props.disabled, false);
  } finally {
    second.dispose();
  }
});

test('actual team selection invalidates a previous status read before a new goal can be overwritten', async () => {
  const late = deferred<Response>(),
    env = environment();
  const completed: BotTeamPlan = { ...team, status: 'error', error: '生成未完成' };
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    teamProps(),
    (async (url: any) =>
      String(url).endsWith('/bot-team-plans') ? json([completed]) : late.promise) as typeof fetch,
    env,
  );
  try {
    await ui.flush();
    ui.button('发布协作组生成未完成').props.onClick();
    await ui.flush();
    ui.button('检查状态').props.onClick();
    await ui.flush();
    ui.button('规划新的团队').props.onClick();
    await ui.flush();
    ui.field('希望团队').props.onChange({ target: { value: '另一个全新的目标' } });
    await ui.flush();
    late.resolve(json(completed));
    await ui.flush();
    assert.equal(ui.field('希望团队').props.value, '另一个全新的目标');
    assert.ok(ui.button('生成组队方案'));
    assert.equal(ui.maybeButton('重新生成组队方案'), undefined);
  } finally {
    late.resolve(json(completed));
    ui.dispose();
  }
});

test('actual chat proposal cards show safe source and all persisted states, expose editing only to owners and never embed instructions', async () => {
  const { BotTeamProposalCard, parseBotTeamProposal } = await compile(
    'web/src/components/BotTeamProposalCard.tsx',
  );
  const owner = render(BotTeamProposalCard, {
    ...cardProps(),
    proposal: { ...proposal, goal: '<script>unsafe()</script>' },
  });
  assert.match(owner, /由 首席助理 提出/);
  assert.match(owner, /负责人/);
  assert.match(owner, /协调与汇总/);
  assert.match(owner, /查看并调整方案/);
  assert.match(owner, /&lt;script&gt;/);
  assert.doesNotMatch(owner, /<script>|开始协作|确认创建协作团队/);
  for (const [status, label] of [
    ['generating', '正在规划'],
    ['ready', '等待拥有者确认'],
    ['committed', '协作团队已创建'],
    ['cancelled', '方案已取消'],
    ['error', '方案未完成'],
  ]) {
    const html = render(BotTeamProposalCard, {
      ...cardProps(),
      proposal: {
        ...proposal,
        status,
        ...(status === 'committed' ? { result: committedTeam.result } : {}),
      },
      owner: false,
    });
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, />查看方案|>查看并调整方案|>确认创建|>开始协作/);
    if (status === 'ready') assert.match(html, /请空间拥有者/);
  }
  const missing = render(BotTeamProposalCard, {
    ...cardProps(),
    proposal: { ...proposal, status: 'committed', result: committedTeam.result },
    canOpenConversation: false,
  });
  assert.doesNotMatch(missing, /进入协作群聊/);
  assert.match(missing, /暂不可用/);
  assert.ok(parseBotTeamProposal(proposal));
  assert.equal(
    parseBotTeamProposal({ ...proposal, planId: 'https://evil.example/plan' }),
    undefined,
  );
  assert.equal(
    parseBotTeamProposal({ ...proposal, members: [{ ...proposal.members[0], assignment: {} }] }),
    undefined,
  );
  assert.equal(parseBotTeamProposal({ ...proposal, result: false }), undefined);
});

test('actual owner card opens only its existing plan, while permission changes and unmount revoke old callbacks without network writes', async () => {
  const opened: string[] = [],
    calls: string[] = [];
  const ui = await harness(
    'web/src/components/BotTeamProposalCard.tsx',
    'ProposalContent',
    { ...cardProps(), onOpenPlan: (id: string) => opened.push(id) },
    (async (url: any) => {
      calls.push(String(url));
      return json({});
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    const open = ui.button('查看并调整方案').props.onClick;
    open();
    assert.deepEqual(opened, [team.id]);
    assert.equal(calls.length, 0);
    ui.setProps({ owner: false });
    await ui.flush();
    open();
    assert.equal(opened.length, 1);
    assert.equal(ui.maybeButton('查看并调整方案'), undefined);
    ui.setProps({ owner: true });
    await ui.flush();
    const current = ui.button('查看并调整方案').props.onClick;
    ui.dispose();
    current();
    assert.equal(opened.length, 1);
    assert.equal(calls.length, 0);
  } finally {
    ui.dispose();
  }
});

test('actual committed card checks the current group and members with a fixed account scope, rejects missing chats and drops late navigation', async () => {
  for (const outcome of ['success', 'missing', 'member-missing', 'unmount'] as const) {
    const late = deferred<Response>(),
      calls: Array<{ url: string; init: RequestInit }> = [],
      opened: any[] = [];
    const ui = await harness(
      'web/src/components/BotTeamProposalCard.tsx',
      'ProposalContent',
      {
        ...cardProps(),
        owner: false,
        proposal: { ...proposal, status: 'committed', result: committedTeam.result },
        onOpenConversation: (value: any) => opened.push(value),
      },
      (async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        return late.promise;
      }) as typeof fetch,
    );
    await ui.flush();
    const open = ui.button('进入协作群聊').props.onClick;
    open();
    open();
    await ui.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/workspaces/space-a/bootstrap');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal((calls[0].init.headers as any)['X-OpenBot-Expected-User'], 'owner-a');
    if (outcome === 'unmount') ui.dispose();
    const snapshot = teamBootstrap();
    late.resolve(
      json(
        outcome === 'missing'
          ? { ...snapshot, conversations: [] }
          : outcome === 'member-missing'
            ? { ...snapshot, agents: [agent] }
            : snapshot,
      ),
    );
    await ui.flush();
    if (outcome === 'success') {
      assert.equal(opened.length, 1);
      assert.equal(opened[0].conversation.title, '真实群聊');
    } else {
      assert.equal(opened.length, 0);
      if (outcome !== 'unmount') assert.match(ui.copy, /不存在或成员暂不可用/);
    }
    ui.dispose();
  }
});

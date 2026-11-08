import test from 'node:test';
import assert from 'node:assert/strict';
import { composerFixture, skill, bot, peer } from './testSupport/composerCommandsFixture';
import type { ConnectedApp } from '../../shared/app-connections';

test('explicit app mention consumes only the token and pins the current connected revision', async () => {
  const app: ConnectedApp = {
    id: 'app-linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp/readonly',
    authType: 'oauth',
    hasCredential: true,
    status: 'connected',
    toolCount: 2,
    revision: 'revision-a',
    createdAt: '',
  };
  const f = await composerFixture({ draft: 'Review @Lin', apps: [app] });
  try {
    await f.focus();
    const stale = f.option('Linear');
    assert.ok(stale);
    const revised = { ...app, revision: 'revision-b' };
    await f.change({ data: { apps: [revised] } });
    stale.props.onClick();
    assert.equal(f.props.currentComposer.appContext, undefined);
    f.option('Linear').props.onClick();
    await f.flush();
    assert.equal(f.props.draft, 'Review ');
    assert.deepEqual(JSON.parse(JSON.stringify(f.props.currentComposer.appContext)), {
      connectionId: 'app-linear',
      revision: 'revision-b',
      name: 'Linear',
    });
    assert.equal(f.props.currentComposer.agentId, undefined);
    assert.equal(f.props.currentComposer.attachments.length, 1);
    assert.equal(f.props.currentComposer.replyTo?.id, 'quoted');
    assert.equal(f.calls.includes('send'), false);
    await f.type('@');
    await f.change({ data: { apps: [{ ...revised, status: 'needs_auth' }] } });
    assert.equal(f.option('Linear'), undefined);
    assert.ok(f.option('Aster'));
  } finally {
    f.dispose();
  }
});

test('member commands expose active skill use and personal settings without a routine management entry', async () => {
  const f = await composerFixture({ member: true, skills: [] });
  try {
    await f.focus();
    assert.equal(f.options().length, 3);
    assert.equal(f.option('例行任务'), undefined);
    assert.equal(f.option('Summarize'), undefined);
    f.option('设置').props.onClick();
    await f.flush();
    assert.ok(f.calls.includes('settings:general'));
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

test('a withdrawn skill or lost owner permission invalidates an already rendered choice', async () => {
  const f = await composerFixture();
  try {
    await f.focus();
    const oldSkill = f.option('Summarize');
    const oldRoutine = f.option('例行任务');
    await f.change({ skills: [{ ...skill, status: 'disabled' }], canManage: false });
    oldSkill.props.onClick();
    oldRoutine.props.onClick();
    await f.flush();
    assert.equal(f.props.draft, '/');
    assert.equal(f.props.currentComposer.agentId, undefined);
    assert.equal(
      f.calls.some((call) => call.startsWith('modal:')),
      false,
    );
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

test('late menu handlers cannot change another account, conversation, draft or selected range', async () => {
  for (const change of ['account', 'conversation', 'draft', 'selection']) {
    const f = await composerFixture();
    try {
      await f.focus();
      const old = f.option('设置');
      if (change === 'account') f.switchIdentity();
      if (change === 'conversation') await f.change({ selected: 'other-chat' });
      if (change === 'draft') await f.type('/settings additional text');
      if (change === 'selection') f.field.setSelectionRange(0, 1);
      const before = f.props.draft;
      old.props.onClick();
      await f.flush();
      assert.equal(f.props.draft, before);
      assert.equal(f.calls.includes('settings:general'), false);
      assert.equal(f.calls.includes('send'), false);
    } finally {
      f.dispose();
    }
  }
});

test('readonly fields cannot select a shortcut or submit through Enter', async () => {
  const f = await composerFixture();
  try {
    await f.focus();
    const old = f.option('设置');
    f.field.readOnly = true;
    old.props.onClick();
    await f.key('Enter');
    assert.equal(f.props.draft, '/');
    assert.equal(f.calls.includes('settings:general'), false);
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

test('same-name group skills retain their owning Bot and explicit recipients narrow the list', async () => {
  const f = await composerFixture({
    skills: [skill, { ...skill, id: 'peer-skill', agentId: peer.id }],
  });
  try {
    await f.focus();
    const own = f.option('Aster'),
      other = f.option('Birch');
    assert.ok(own);
    assert.ok(other);
    other.props.onClick();
    await f.flush();
    assert.equal(f.props.currentComposer.agentId, peer.id);
    assert.equal(f.calls.includes('send'), false);
    await f.type('/');
    assert.equal(f.option('Aster'), undefined);
    assert.ok(f.option('Birch'));
    await f.change({ currentComposer: { ...f.props.currentComposer, agentId: bot.id } });
    assert.ok(f.option('Aster'));
    assert.equal(f.option('Birch'), undefined);
  } finally {
    f.dispose();
  }
});

test('English command labels and inserted skill request are localized without translating stored skill names', async () => {
  const f = await composerFixture({ language: 'en' });
  try {
    await f.focus();
    assert.ok(f.option('Settings'));
    assert.ok(f.option('Routines'));
    f.option('Summarize').props.onClick();
    await f.flush();
    assert.equal(f.props.draft, 'Please use the “Summarize” skill for the following:\n');
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

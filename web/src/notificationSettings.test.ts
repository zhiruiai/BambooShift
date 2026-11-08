import test from 'node:test';
import assert from 'node:assert/strict';
import {
  all,
  base,
  component,
  deferred,
  env,
  harness,
} from './testSupport/memoryImportSettingsFixture';
import { completed, input, snapshot, storage } from './testSupport/notificationsFixture';

function environment(native?: Record<string, unknown>) {
  const events = new EventTarget();
  const saved = storage();
  const baseEnv = env();
  return {
    ...baseEnv,
    saved,
    window: Object.assign(events, baseEnv.window, {
      localStorage: saved,
      openbotNotifications: native,
    }),
    document: { hidden: true, hasFocus: () => false },
  };
}
const props = {
  workspaceId: base.workspaceId,
  userId: base.userId,
  active: true,
  agents: [{ id: 'bot-a', name: 'Synthetic Bot' }],
};

test('the actual settings form never requests permission automatically; user toggles persist only their scoped preferences', async () => {
  let requests = 0;
  const calls: unknown[] = [];
  const globals = environment({
    permission: async () => 'prompt',
    requestPermission: async (scope: unknown) => {
      requests++;
      calls.push(scope);
      return 'granted';
    },
    show: async () => true,
    clear: async () => {},
  });
  const h = await harness(
    'web/src/components/NotificationsPanel.tsx',
    'NotificationsContent',
    props,
    globals,
  );
  try {
    await h.flush();
    assert.equal(requests, 0);
    const fields = all(h.tree, (node) => node.type === 'input');
    assert.equal(fields[0].props.checked, false);
    fields[0].props.onChange({ target: { checked: true } });
    await h.flush();
    assert.equal(requests, 0);
    h.button('允许系统通知').props.onClick();
    await h.flush();
    assert.equal(requests, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
      workspaceId: props.workspaceId,
      expectedUser: props.userId,
    });
    assert.match(h.copy, /已允许发送通知/);
    const enabled = all(h.tree, (node) => node.type === 'input');
    enabled[3].props.onChange({ target: { checked: false } });
    await h.flush();
    const stored = [...globals.saved.values.values()].join('');
    assert.match(stored, /bot-a/);
    assert.doesNotMatch(stored, /Synthetic Bot/);
    const prior = all(h.tree, (node) => node.type === 'input')[0].props.onChange;
    h.setProps({ active: false });
    await h.flush();
    prior({ target: { checked: false } });
    await h.flush();
    assert.equal([...globals.saved.values.values()].join(''), stored);
  } finally {
    h.dispose();
  }
});

test('permission results returning after an account switch are ignored, and unavailable storage is visible', async () => {
  const result = deferred<'granted'>();
  let requests = 0;
  const globals = environment({
    permission: async () => 'prompt',
    requestPermission: () => {
      requests++;
      return result.promise;
    },
    show: async () => true,
    clear: async () => {},
  });
  const h = await harness(
    'web/src/components/NotificationsPanel.tsx',
    'NotificationsContent',
    props,
    globals,
  );
  try {
    await h.flush();
    all(h.tree, (node) => node.type === 'input')[0].props.onChange({ target: { checked: true } });
    await h.flush();
    const request = h.button('允许系统通知');
    request.props.onClick();
    await h.flush();
    assert.equal(requests, 1);
    h.setProps({ userId: 'another-user' });
    await h.flush();
    result.resolve('granted');
    await h.flush();
    assert.doesNotMatch(h.copy, /已允许发送通知/);
    request.props.onClick();
    assert.equal(requests, 1);
  } finally {
    h.dispose();
  }
  const blocked = environment();
  blocked.saved.setItem = () => {
    throw Error('blocked');
  };
  const failed = await harness(
    'web/src/components/NotificationsPanel.tsx',
    'NotificationsContent',
    props,
    blocked,
  );
  try {
    await failed.flush();
    all(failed.tree, (node) => node.type === 'input')[0].props.onChange({
      target: { checked: true },
    });
    await failed.flush();
    assert.match(failed.copy, /通知偏好或去重记录无法保存/);
    assert.match(failed.copy, /不支持系统通知/);
  } finally {
    failed.dispose();
  }
});

test('the actual workspace notification hook handles real message callbacks and cancels retained callbacks on account change or unmount', async () => {
  const notices: unknown[] = [];
  let clears = 0,
    requests = 0;
  const globals = environment({
    permission: async () => 'granted',
    requestPermission: async () => {
      requests++;
      return 'granted';
    },
    show: async (notice: unknown) => {
      notices.push(notice);
      return true;
    },
    clear: async () => {
      clears++;
    },
  });
  globals.saved.setItem(
    `openbot-notifications:v1:${base.userId}:${base.workspaceId}`,
    JSON.stringify({ version: 1, enabled: true, completed: true, approvals: true, mutedBots: [] }),
  );
  const h = await harness(
    'web/src/useNotifications.ts',
    'useWorkspaceNotifications',
    { workspaceId: base.workspaceId, userId: base.userId, isOwner: false },
    globals,
  );
  try {
    await h.flush();
    const callbacks = h.tree;
    callbacks.baseline(snapshot([input(base.userId)]));
    callbacks.receive(completed('live'));
    await h.flush();
    assert.equal(notices.length, 1);
    assert.equal(requests, 0);
    assert.equal((notices[0] as Record<string, unknown>).body, '');
    h.setProps({ userId: 'another-user' });
    await h.flush();
    callbacks.receive(completed('late'));
    await h.flush();
    assert.equal(notices.length, 1);
    assert.ok(clears >= 1);
    h.dispose();
    callbacks.receive(completed('unmounted'));
    assert.equal(notices.length, 1);
  } finally {
    h.dispose();
  }
});

test('notifications remain reachable for members without changing model or memory permissions', async () => {
  const data = {
    agents: props.agents,
    conversations: [],
    messages: [],
    memories: [],
    routines: [],
    skills: [],
    files: [],
    settings: { configured: false },
    computer: {},
  };
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    {
      data,
      ...props,
      canManage: false,
      team: true,
      onClose() {},
      onSettingsChanged() {},
      onPrimaryChanged() {},
      onImported: async () => {},
      onTimeZoneChanged() {},
    },
    env(),
  );
  try {
    await h.flush();
    component(h.tree, 'SettingsNavigation').props.onChange('notifications');
    await h.flush();
    assert.equal(component(h.tree, 'NotificationsPanel').props.active, true);
    assert.equal(component(h.tree, 'NotificationsPanel').props.userId, base.userId);
    assert.equal(component(h.tree, 'WorkspaceTimeZoneSettings').props.canManage, false);
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, false);
  } finally {
    h.dispose();
  }
});

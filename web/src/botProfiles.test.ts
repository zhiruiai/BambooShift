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
  all,
  harness,
  agent,
  team,
  settingsProps,
} from './testSupport/botProfilesFixture';

test('actual Bot settings open only the existing conversation through the dirty-navigation confirmation and keep team visibility explicit', async () => {
  let opened = 0;
  const calls: string[] = [];
  const ui = await harness(
    'web/src/components/AgentDialog.tsx',
    'AgentSettingsContent',
    {
      ...settingsProps(),
      workspaceKind: 'team',
      conversationAvailable: true,
      onOpenConversation: () => opened++,
    },
    async (url) => {
      calls.push(String(url));
      return json({});
    },
  );
  try {
    await ui.flush();
    ui.button('打开团队可见会话').props.onClick();
    assert.equal(opened, 1);
    ui.field('Bot 名称').props.onChange({ target: { value: '未保存的名字' } });
    await ui.flush();
    ui.button('打开团队可见会话').props.onClick();
    await ui.flush();
    assert.equal(opened, 1);
    assert.match(ui.copy, /未保存的修改/);
    ui.button('继续编辑').props.onClick();
    await ui.flush();
    assert.equal(ui.field('Bot 名称').props.value, '未保存的名字');
    ui.button('打开团队可见会话').props.onClick();
    await ui.flush();
    ui.button('放弃修改并继续').props.onClick();
    assert.equal(opened, 2);
    assert.equal(
      calls.length,
      0,
      'opening a conversation never saves Bot settings or creates a DM',
    );
  } finally {
    ui.dispose();
  }
});

test('actual existing-conversation callbacks stop when availability, identity, URL or mounted scope changes, including a pending discard confirmation', async () => {
  for (const change of ['missing', 'user', 'workspace', 'url', 'unmount', 'discard'] as const) {
    let opened = 0;
    const window = Object.assign(new EventTarget(), { location: { pathname: '/w/space-a' } });
    const ui = await harness(
      'web/src/components/AgentDialog.tsx',
      'AgentSettingsContent',
      {
        ...settingsProps(),
        workspaceKind: 'personal',
        conversationAvailable: true,
        onOpenConversation: () => opened++,
      },
      async () => {
        throw Error('No network is allowed for the navigation control');
      },
      { window },
    );
    try {
      await ui.flush();
      let open = ui.button('打开私人会话').props.onClick;
      if (change === 'discard') {
        ui.field('Bot 名称').props.onChange({ target: { value: '草稿保留' } });
        await ui.flush();
        ui.button('打开私人会话').props.onClick();
        await ui.flush();
        open = ui.button('放弃修改并继续').props.onClick;
      }
      if (change === 'missing') ui.setProps({ conversationAvailable: false });
      if (change === 'user' || change === 'discard') ui.setProps({ userId: 'different-user' });
      if (change === 'workspace') ui.setProps({ workspaceId: 'space-b' });
      if (change === 'url') window.location.pathname = '/w/space-b';
      if (change === 'unmount') ui.dispose();
      await ui.flush();
      open();
      await ui.flush();
      assert.equal(opened, 0, change);
      if (change === 'missing') {
        assert.equal(ui.button('打开私人会话').props.disabled, true);
        assert.match(ui.copy, /不会另建会话/);
      }
    } finally {
      ui.dispose();
    }
  }
});

test('shared Bot profile fields expose all six original shapes, colors and independent description/instructions with mobile targets', async () => {
  const { BotProfileFields } = await compile('web/src/components/BotProfileFields.tsx');
  const html = render(BotProfileFields, { draft: agent, onChange() {} });
  for (const name of ['圆团', '水滴', '叶子', '火花', '宝石', '拱形'])
    assert.match(html, new RegExp(`头像形状 ${name}`));
  assert.equal((html.match(/头像颜色 /g) || []).length, 6);
  assert.match(html, /简介/);
  assert.match(html, /长期指令/);
  assert.match(html, /maxLength="16000"/);
  const css = await readFile('web/src/components/BotProfiles.css', 'utf8');
  assert.match(css, /\.bot-identity-picker \.shape-choices button[^}]*height: 44px/s);
});

test('actual upload selector supports keyboard and pointer cropping, stages only a UUID and keeps original shape controls', async () => {
  const sourceId = '33333333-3333-4333-8333-333333333333',
    imageId = '55555555-5555-4555-8555-555555555555';
  const source = {
    id: sourceId,
    width: 1600,
    height: 900,
    previewWidth: 1024,
    previewHeight: 576,
    expiresAt: '2030-01-01T00:00:00Z',
  };
  const writes: Array<{ url: string; init: RequestInit }> = [],
    changed: any[] = [],
    activity: any[] = [],
    revoked: string[] = [];
  class BlobURL extends URL {
    static createObjectURL() {
      return 'blob:avatar-test';
    }
    static revokeObjectURL(value: string) {
      revoked.push(value);
    }
  }
  const ui = await harness(
    'web/src/components/AvatarPicker.tsx',
    'AvatarPickerContent',
    {
      draft: { ...agent, avatarImageId: null },
      onChange: (value: unknown) => changed.push(value),
      onActivity: (value: unknown) => activity.push(value),
    },
    async (url, init) => {
      writes.push({ url: String(url), init: init! });
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : String(url).endsWith('/sources')
          ? json(source)
          : init?.method === 'POST'
            ? json({
                id: imageId,
                width: 512,
                height: 512,
                mimeType: 'image/webp',
                createdAt: '2026-11-05T00:00:00Z',
              })
            : new Response(new Blob(['webp'], { type: 'image/webp' }));
    },
    { URL: BlobURL },
  );
  await ui.flush();
  ui.button('上传图片').props.onClick();
  await ui.flush();
  const input = all(ui.tree, (node) => node.type === 'input' && node.props.type === 'file')[0];
  input.props.onChange({
    target: { files: [new Blob(['png'], { type: 'image/png' })], value: 'photo.png' },
  });
  await ui.flush();
  assert.equal(changed.length, 0);
  assert.equal(activity.at(-1).pending, true);
  let frame = all(ui.tree, (node) => node.props?.className === 'avatar-crop-frame')[0];
  frame.props.onKeyDown({ key: '+', preventDefault() {}, shiftKey: false });
  await ui.flush();
  assert.equal(ui.field('缩放').props.value, 1.1);
  frame = all(ui.tree, (node) => node.props?.className === 'avatar-crop-frame')[0];
  frame.props.onKeyDown({ key: 'Home', preventDefault() {} });
  await ui.flush();
  assert.equal(ui.field('缩放').props.value, 1);
  ui.field('缩放').props.onChange({ target: { value: '2' } });
  await ui.flush();
  const captured: number[] = [],
    released: number[] = [];
  const target = {
    focus() {},
    setPointerCapture: (id: number) => captured.push(id),
    releasePointerCapture: (id: number) => released.push(id),
    getBoundingClientRect: () => ({ width: 280 }),
  };
  frame = all(ui.tree, (node) => node.props?.className === 'avatar-crop-frame')[0];
  frame.props.onPointerDown({
    button: 0,
    pointerId: 7,
    clientX: 100,
    clientY: 100,
    currentTarget: target,
    preventDefault() {},
  });
  frame.props.onPointerMove({ pointerId: 7, clientX: 170, clientY: 100, currentTarget: target });
  await ui.flush();
  frame = all(ui.tree, (node) => node.props?.className === 'avatar-crop-frame')[0];
  frame.props.onPointerUp({ pointerId: 7, currentTarget: target });
  assert.deepEqual(captured, [7]);
  assert.deepEqual(released, [7]);
  ui.button('使用这张头像').props.onClick();
  await ui.flush();
  const crop = writes.find((call) => call.url.endsWith('/bot-avatars'))!;
  assert.deepEqual(JSON.parse(String(crop.init.body)), {
    sourceId,
    crop: { left: 463, top: 225, size: 450 },
  });
  assert.equal(changed[0].avatarImageId, imageId);
  assert.equal(activity.at(-1).pending, false);
  assert.deepEqual(revoked, ['blob:avatar-test']);
  assert.ok(writes.every((call) => !call.url.includes('/agents')));
  ui.setProps({ draft: { ...agent, avatarImageId: imageId } });
  await ui.flush();
  ui.button('原创形象').props.onClick();
  await ui.flush();
  ui.button('头像形状 水滴').props.onClick();
  assert.equal(changed.at(-1).avatar, 'drop');
  assert.equal(changed.at(-1).avatarImageId, null);
  ui.dispose();
});

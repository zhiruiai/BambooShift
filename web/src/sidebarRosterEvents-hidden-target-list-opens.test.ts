import { componentSource } from './testSupport/componentSource';
import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import type { SidebarRosterState, SidebarRosterOperation } from '../../shared/sidebar-roster';
import {
  require,
  empty,
  section,
  withSection,
  target,
  agent,
  conversation,
  data,
  copy,
  all,
  harness,
  componentFile,
  baseController,
  dialogProps,
} from './testSupport/sidebarRosterEventsFixture';

test('hidden target list opens history without restoring; restore changes only hidden and does not navigate', async () => {
  const hidden = { ...empty, entries: [{ target, pinned: true, hidden: true, sectionId: null }] };
  const writes: any[] = [];
  let opened = 0,
    closed = 0;
  const controller = {
    ...baseController(hidden),
    async write(operation: SidebarRosterOperation) {
      writes.push(operation);
      return { ok: true as const, state: empty };
    },
  };
  const h = await harness(componentFile, 'RosterDialogContent', {
    ...dialogProps({ kind: 'hidden' }, hidden),
    data: { ...data(hidden), conversations: [conversation, { ...conversation, id: 'dm-second' }] },
    roster: controller,
    onOpen() {
      opened++;
    },
    onClose() {
      closed++;
    },
  });
  await h.flush();
  assert.equal(all(h.tree, (node) => node.type === 'button' && copy(node) === '恢复').length, 1);
  h.button('恢复').props.onClick();
  await h.flush();
  assert.equal(opened, 0);
  assert.equal(closed, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [
    { type: 'set-entry', target, hidden: false },
  ]);
  h.button('查看对话').props.onClick();
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(writes.length, 1);
  h.dispose();
});

test('roster row actions offer atomic new-section move and preserve target identity for pins and hides', async () => {
  const writes: any[] = [],
    dialogs: any[] = [],
    notices: string[] = [];
  let focus = 0;
  const fallback = {
    isConnected: true,
    focus() {
      focus++;
    },
  };
  const h = await harness(
    componentFile,
    'SidebarRosterList',
    {
      data: data(withSection),
      query: '',
      mobile: false,
      selected: conversation.id,
      now: 0,
      roster: {
        ...baseController(withSection),
        async write(operation: SidebarRosterOperation) {
          writes.push(operation);
          return { ok: true as const, state: withSection };
        },
      },
      working() {
        return false;
      },
      onOpen() {},
      onDialog(request: any) {
        dialogs.push(request);
      },
      onPrimary() {},
      onNotice(notice: string) {
        notices.push(notice);
      },
    },
    undefined,
    {
      document: {
        getElementById() {
          return fallback;
        },
      },
      requestAnimationFrame(callback: () => void) {
        callback();
      },
    },
  );
  await h.flush();
  const menu = all(h.tree, (node) => node.props?.label === `${conversation.title}的名单选项`)[0];
  assert.ok(menu);
  menu.props.actions.find((item: any) => item.label === '移入新分区…').action();
  assert.deepEqual(JSON.parse(JSON.stringify(dialogs)), [{ kind: 'create', target }]);
  menu.props.actions.find((item: any) => item.label === '置顶').action();
  await h.flush();
  menu.props.actions.find((item: any) => item.label === '隐藏').action();
  await h.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [
    { type: 'set-entry', target, pinned: true },
    { type: 'set-entry', target, hidden: true },
  ]);
  assert.equal(focus, 1);
  assert.match(notices.join(' '), /任务不受影响/);
  const toggle = all(
    h.tree,
    (node) => node.type === 'button' && node.props.className?.includes('roster-section-toggle'),
  )[0];
  toggle.props.onClick();
  await h.flush();
  assert.equal(writes[2].type, 'set-section-collapsed');
  assert.equal(notices.length, 2);
  h.dispose();
});

test('menu keyboard and pointer handlers return focus to trigger before dispatching an action', async () => {
  const events: string[] = [];
  const nodes = [
    {
      focus() {
        events.push('first');
      },
    },
    {
      focus() {
        events.push('second');
      },
    },
  ];
  const document = { activeElement: nodes[0], addEventListener() {}, removeEventListener() {} };
  const h = await harness(
    componentFile,
    'RosterActions',
    {
      children: React.createElement('button', null, 'row'),
      label: '名单选项',
      actions: [
        {
          label: '置顶',
          action() {
            events.push('action');
          },
        },
        { label: '隐藏', action() {} },
      ],
    },
    undefined,
    { document, Node: class {} },
  );
  await h.flush();
  const trigger = h.button('名单选项');
  trigger.props.ref.current = {
    focus() {
      events.push('trigger');
    },
    getBoundingClientRect() {
      return { right: 300, bottom: 120 };
    },
  };
  h.tree.props.ref.current = {
    querySelector() {
      return nodes[0];
    },
    querySelectorAll() {
      return nodes;
    },
    contains() {
      return true;
    },
  };
  h.tree.props.onKeyDown({
    key: 'F10',
    shiftKey: true,
    preventDefault() {
      events.push('prevent');
    },
  });
  await h.flush();
  assert.equal(h.button('名单选项').props['aria-expanded'], true);
  h.tree.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(events.at(-1), 'second');
  h.button('置顶').props.onClick();
  assert.deepEqual(events.slice(-2), ['trigger', 'action']);
  await h.flush();
  assert.equal(h.button('名单选项').props['aria-expanded'], false);
  h.tree.props.onContextMenu({ clientX: 40, clientY: 100, preventDefault() {} });
  await h.flush();
  h.tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(events.at(-1), 'trigger');
  h.dispose();
});

test('actual sidebar markup retains primary identity in its assigned section and exposes readonly/mobile recovery', async () => {
  const output = await build({
    entryPoints: [resolve(componentFile)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const module = { exports: {} as Record<string, any> };
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    Error,
    TypeError,
    AbortController,
    AbortSignal,
    DOMException,
    Response,
    URL,
    Event,
  });
  const { renderToStaticMarkup } = require('react-dom/server');
  const assigned = {
    ...withSection,
    entries: [{ target, pinned: false, hidden: false, sectionId: section.id }],
  };
  const primaryBot = {
    available: true,
    revision: 'primary-r1',
    agentId: agent.id,
    conversationId: conversation.id,
    checkIn: { enabled: true, time: '09:00' },
  };
  const props = {
    data: { ...data(assigned), primaryBot },
    query: '',
    mobile: false,
    selected: conversation.id,
    now: 0,
    roster: baseController(assigned),
    working() {
      return false;
    },
    onOpen() {},
    onDialog() {},
    onPrimary() {},
    onNotice() {},
  };
  const markup = renderToStaticMarkup(React.createElement(module.exports.SidebarRosterList, props));
  assert.equal((markup.match(/class="primary-bot-badge"/g) || []).length, 1);
  assert.match(markup, /aria-label="研究"/);
  assert.match(markup, /每天 09:00/);
  assert.match(markup, /已隐藏/);
  assert.match(markup, /aria-haspopup="menu"/);
  const hidden = { ...assigned, entries: [{ ...assigned.entries[0], hidden: true }] };
  const mobile = renderToStaticMarkup(
    React.createElement(module.exports.SidebarRosterList, {
      ...props,
      mobile: true,
      data: { ...data(hidden), primaryBot },
      roster: baseController(hidden),
    }),
  );
  assert.doesNotMatch(mobile, /class="primary-bot-badge"/);
  assert.match(mobile, /名单已全部隐藏/);
  assert.match(mobile, /id="roster-hidden-entry"/);
  const readonly = renderToStaticMarkup(
    React.createElement(module.exports.SidebarRosterList, {
      ...props,
      data: data(),
      roster: { ...baseController(), state: undefined },
    }),
  );
  assert.match(readonly, /暂不支持个人名单设置/);
  assert.match(readonly, /<button type="button" disabled="">[^<]*<svg/);
});

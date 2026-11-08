import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import type { AppSettings, BotAgent, ModelProfile } from '../../shared/types';
import type { BotTeamPlan } from '../../shared/bot-team-plans';
import { all, harness } from './testSupport/smartTeamSettingsFixture';

test('only the active Dialog owns Escape, Tab and focus while hidden content remains mounted', async () => {
  const listeners = new Set<(event: any) => void>();
  const document: any = {
    activeElement: undefined,
    addEventListener: (name: string, callback: any) => {
      assert.equal(name, 'keydown');
      listeners.add(callback);
    },
    removeEventListener: (_name: string, callback: any) => listeners.delete(callback),
  };
  const focusable = () => ({
    tabIndex: 0,
    matches: () => false,
    closest: () => null,
    getClientRects: () => [1],
    focus() {
      document.activeElement = this;
    },
  });
  const initial = focusable();
  initial.focus();
  let createClosed = 0,
    modelClosed = 0;
  const createButtons = [focusable(), focusable()],
    modelButtons = [focusable(), focusable()];
  const globals = { document, getComputedStyle: () => ({ visibility: 'visible' }) };
  const bind = (buttons: any[]) => (tree: any) => {
    const node = all(tree, (node) => node.props?.role === 'dialog')[0];
    node.props.ref.current ||= {
      focus() {
        document.activeElement = this;
      },
      querySelectorAll: () => buttons,
    };
  };
  const create = await harness(
    'web/src/components/UI.tsx',
    'Dialog',
    { title: '组队', children: '保留的草稿', onClose: () => createClosed++ },
    globals,
    bind(createButtons),
  );
  let model: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await create.flush();
    assert.equal(listeners.size, 1);
    create.setProps({ active: false });
    await create.flush();
    assert.equal(listeners.size, 0);
    assert.equal(create.tree.props.style.display, 'none');
    assert.equal(create.tree.props.inert, true);
    assert.equal(create.tree.props['aria-hidden'], true);
    assert.match(create.copy, /保留的草稿/);
    model = await harness(
      'web/src/components/UI.tsx',
      'Dialog',
      { title: '配置', onClose: () => modelClosed++ },
      globals,
      bind(modelButtons),
    );
    await model.flush();
    assert.equal(listeners.size, 1);
    for (const listener of listeners) listener({ key: 'Escape' });
    assert.equal(modelClosed, 1);
    assert.equal(createClosed, 0);
    let prevented = false;
    modelButtons[1].focus();
    for (const listener of listeners)
      listener({
        key: 'Tab',
        preventDefault() {
          prevented = true;
        },
      });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, modelButtons[0]);
    model.dispose();
    assert.equal(listeners.size, 0);
    create.setProps({ active: true });
    await create.flush();
    assert.equal(listeners.size, 1);
    for (const listener of listeners) listener({ key: 'Escape' });
    assert.equal(createClosed, 1);
    assert.equal(modelClosed, 1);
  } finally {
    model?.dispose();
    create.dispose();
  }
  assert.equal(listeners.size, 0);
  assert.equal(document.activeElement, initial);
});

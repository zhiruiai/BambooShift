import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server');
async function compile(path: string) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    define: { 'import.meta.hot': 'undefined' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const module = { exports: {} as Record<string, React.ComponentType<any>> };
  runInNewContext(result.outputFiles[0].text, { require, module, exports: module.exports });
  return module.exports;
}
test('local workspace profile has no email or password form; regular accounts retain both', async () => {
  const { AccountSettingsForms } = await compile('web/src/platform/AccountSettingsPage.tsx');
  const common = { gate: { busy: false }, onProfile() {}, onPassword() {}, onRevalidate() {} };
  for (const localOnly of [false, true]) {
    const markup = renderToStaticMarkup(
      React.createElement(AccountSettingsForms, {
        ...common,
        user: {
          id: 'synthetic',
          name: 'Synthetic person',
          email: localOnly ? '' : 'person@example.test',
          localOnly,
        },
      }),
    );
    assert.equal(markup.includes('id="account-password-heading"'), !localOnly);
    assert.equal(markup.includes('autoComplete="username"'), !localOnly);
    assert.ok(markup.includes('Synthetic person'));
  }
});
test('local chooser labels personal space and omits team creation and sign-out controls', async () => {
  const { WorkspaceChooser } = await compile('web/src/platform/AccountAccess.tsx');
  for (const localOnly of [false, true]) {
    const markup = renderToStaticMarkup(
      React.createElement(WorkspaceChooser, {
        session: {
          authenticated: true,
          user: { id: 'synthetic', name: 'Synthetic person', email: '', localOnly },
          workspaces: [],
        },
      }),
    );
    assert.equal((markup.match(/<button/g) || []).length, localOnly ? 0 : 2);
    assert.equal(markup.includes('本机个人空间'), localOnly);
  }
});

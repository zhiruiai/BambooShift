import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  AVATAR_SHAPES,
  AVATAR_THEMES,
  avatarColor,
  avatarShape,
  avatarTheme,
} from './avatarThemes';
import { APPEARANCE_STORAGE_KEY, createAppearanceStore } from './appearance';
import { AvatarArtwork } from './components/AvatarArtwork';

test('existing device preferences preserve page appearance and default only the new avatar theme', () => {
  let raw = JSON.stringify({ version: 1, theme: 'dark', accent: 'neutral', spellCheck: false });
  const events = new EventTarget();
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
  const store = createAppearanceStore({ storage, storageEvents: events });
  try {
    assert.equal(store.getSnapshot().avatarTheme, 'companions');
    store.update({ avatarTheme: 'pandas' });
    assert.deepEqual(JSON.parse(raw), {
      version: 1,
      theme: 'dark',
      accent: 'neutral',
      spellCheck: false,
      avatarTheme: 'pandas',
    });
    const reopened = createAppearanceStore({ storage });
    assert.equal(reopened.getSnapshot().avatarTheme, 'pandas');
    reopened.dispose();
    raw = JSON.stringify({ ...JSON.parse(raw), avatarTheme: 'dinosaurs' });
    events.dispatchEvent(
      Object.assign(new Event('storage'), { key: APPEARANCE_STORAGE_KEY, storageArea: storage }),
    );
    assert.equal(store.getSnapshot().avatarTheme, 'dinosaurs');
    const before = store.getSnapshot();
    store.update({ avatarTheme: 'invalid' } as any);
    assert.equal(store.getSnapshot(), before);
    store.update({ theme: 'light' });
    assert.equal(store.getSnapshot().avatarTheme, 'dinosaurs');
    for (const theme of ['chicks', 'elephants'] as const) {
      store.update({ avatarTheme: theme });
      const loaded = createAppearanceStore({ storage });
      assert.equal(loaded.getSnapshot().avatarTheme, theme);
      assert.equal(loaded.getSnapshot().theme, 'light');
      loaded.dispose();
    }
  } finally {
    store.dispose();
  }
});

test('the original SVG families contain six distinct forms and safe Bot colors without external content', async () => {
  const images = new Set<string>();
  for (const theme of AVATAR_THEMES)
    for (const shape of AVATAR_SHAPES) {
      const svg = renderToStaticMarkup(
        React.createElement(AvatarArtwork, { theme, shape, color: '#123456', size: 512 }),
      );
      assert.match(svg, new RegExp(`data-avatar-theme="${theme}"`));
      assert.match(svg, new RegExp(`data-avatar-shape="${shape}"`));
      assert.match(svg, /#123456/);
      assert.doesNotMatch(svg, /<image|<foreignObject|<script|<filter|href=|url\(/);
      images.add(svg.replace(/^<svg[^>]*>/, ''));
      const png = await sharp(`web/public/avatars/${theme}/${shape}.png`).metadata();
      assert.equal(png.width, 512);
      assert.equal(png.height, 512);
      const exported = await readFile(`web/public/avatars/${theme}/${shape}.svg`, 'utf8');
      assert.match(exported, new RegExp(`data-avatar-theme="${theme}"`));
      assert.equal(await readFile(`mobile/assets/avatars/${theme}/${shape}.svg`, 'utf8'), exported);
    }
  assert.equal(images.size, 30);
  assert.equal(avatarTheme(undefined), 'companions');
  assert.equal(avatarTheme({ toString: () => 'pandas' }), 'companions');
  assert.equal(avatarShape('https://untrusted.test'), 'orb');
  assert.equal(avatarColor('url(https://untrusted.test)'), '#8a61ee');
  assert.equal(avatarColor('#A1B2C3'), '#A1B2C3');
});

test('actual appearance chooser changes every Avatar while uploaded images keep precedence', async () => {
  const bundle = await build({
    stdin: {
      contents:
        "export { Avatar, GroupAvatar } from './web/src/components/Avatar'; export { AppearanceSettings } from './web/src/components/AppearanceSettings';",
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*'],
    loader: { '.css': 'empty' },
  });
  const require = createRequire(import.meta.url);
  const values = new Map<string, string>();
  const window = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    location: { pathname: '/', search: '' },
  });
  const hooks = {
    ...React,
    useContext: () => null,
    useRef: (value: unknown) => ({ current: value }),
    useEffect: () => {},
    useState: (value: unknown) => [value, () => {}],
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
  const module = { exports: {} as any };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    window,
    document: { documentElement: { dataset: {}, style: {} } },
    require: (name: string) => (name === 'react' ? hooks : require(name)),
  });
  const all = (node: any): any[] =>
    !node || typeof node !== 'object'
      ? []
      : Array.isArray(node)
        ? node.flatMap(all)
        : [node, ...all(node.props?.children)];
  const controls = all(module.exports.AppearanceSettings({})).filter(
    (node) => node.type === 'button',
  );
  assert.equal(controls.length, AVATAR_THEMES.length);
  const one = { id: 'a', avatar: 'orb', color: '#123456' };
  const two = { id: 'b', avatar: 'leaf', color: '#654321' };
  for (const theme of ['dinosaurs', 'chicks', 'elephants'] as const) {
    controls[AVATAR_THEMES.indexOf(theme)].props.onClick();
    for (const agent of [one, two]) {
      const markup = renderToStaticMarkup(module.exports.Avatar({ agent }));
      assert.match(markup, new RegExp(`data-avatar-theme="${theme}"`));
      assert.match(markup, new RegExp(agent.color));
    }
    assert.equal(JSON.parse(values.get(APPEARANCE_STORAGE_KEY)!).avatarTheme, theme);
  }
  const uploaded = renderToStaticMarkup(
    module.exports.Avatar({
      agent: { ...one, avatarImageId: '11111111-1111-4111-8111-111111111111' },
    }),
  );
  assert.match(uploaded, /<img/);
  assert.doesNotMatch(uploaded, /<svg/);
  const hidden = all(module.exports.AppearanceSettings({ active: false })).filter(
    (node) => node.type === 'button',
  );
  hidden[0].props.onClick();
  assert.equal(JSON.parse(values.get(APPEARANCE_STORAGE_KEY)!).avatarTheme, 'elephants');
});

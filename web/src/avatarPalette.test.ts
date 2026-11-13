import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AVATAR_PALETTE, AVATAR_COLORS, displayAvatarColor } from '../../shared/avatar-palette';
import { AVATAR_SHAPES, AVATAR_THEMES, avatarColor } from './avatarThemes';
import { AvatarArtwork, AvatarSourceArtwork } from './components/AvatarArtwork';
import { GeneratedAvatarArtwork } from './components/GeneratedAvatarArtwork';
import { botColors, botProfileDraft } from './botProfiles';
import type { GeneratedAvatarTheme } from './creationPreview';

test('legacy and custom violet vector colors use the natural palette without mutating data', () => {
  for (const [old, next] of Object.entries(AVATAR_PALETTE.legacy)) {
    assert.equal(displayAvatarColor(old), next);
    assert.equal(displayAvatarColor(old.toUpperCase()), next);
  }
  for (const color of ['#8651d8', '#8b5eaa', '#663399', '#c18ae1'])
    assert.equal(displayAvatarColor(color), AVATAR_PALETTE.defaultColor);
  // Preserve near-gray/near-black, skin-like warm colors, and unrelated custom colors.
  for (const color of ['#000000', '#ffffff', '#29253a', '#928c93', '#E2B59A', '#A1B2C3', '#123456'])
    assert.equal(displayAvatarColor(color), color);
  for (const shape of AVATAR_SHAPES)
    assert.equal(avatarColor(undefined, shape), AVATAR_PALETTE.roles[shape]);
  assert.equal(displayAvatarColor('url(https://invalid.test)'), AVATAR_PALETTE.defaultColor);
});

test('every original and community theme recolors vector fills while retaining source geometry', () => {
  for (const theme of AVATAR_THEMES) {
    const props = { theme, color: '#9363ed', shape: 'orb', size: 512 };
    const derived = renderToStaticMarkup(React.createElement(AvatarArtwork, props));
    const source = renderToStaticMarkup(React.createElement(AvatarSourceArtwork, props));
    assert.match(derived, /#3F7F64/);
    assert.doesNotMatch(derived, /#9363ed/);
    assert.match(source, /#9363ed/);
    const paths = (svg: string) => [...svg.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(paths(derived), paths(source), theme);
    assert.match(derived, /width="512" height="512"/);
    assert.doesNotMatch(derived, /<image|<filter/);
  }
});

test('generated decorations and legacy picker selections use the derived color, preserving stored values', async () => {
  const theme: GeneratedAvatarTheme = {
    name: 'Synthetic natural theme',
    motif: 'grokbot-blob',
    colors: ['#8b5eaa', '#123456', '#E2B59A'],
    backdrop: 'solid',
    badge: 'none',
  };
  const saved = structuredClone(theme);
  const result = renderToStaticMarkup(
    React.createElement(GeneratedAvatarArtwork, { theme, shape: 'orb' }),
  );
  assert.match(result, /fill="#3F7F64"/);
  assert.match(result, /stroke="#3F7F64"/);
  assert.doesNotMatch(result, /#8b5eaa/);
  assert.deepEqual(theme, saved);
  assert.deepEqual(botColors, AVATAR_COLORS);
  assert.equal(new Set(botColors).size, 6);
  assert.equal(botProfileDraft().color, '#3F7F64');
  const bundle = await build({
    entryPoints: ['web/src/components/AvatarPicker.tsx'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*'],
    loader: { '.css': 'empty' },
    define: { 'import.meta.hot': 'undefined' },
  });
  const module = { exports: {} as { AvatarPicker: React.ComponentType<any> } };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
  });
  for (const color of ['#9363ed', '#3f7f64']) {
    const draft = { ...botProfileDraft(), color };
    const picker = renderToStaticMarkup(
      React.createElement(module.exports.AvatarPicker, { draft, onChange() {} }),
    );
    assert.match(picker, /aria-pressed="true" class="chosen"[^>]*><span style="background:#3F7F64"/);
    assert.equal(draft.color, color);
  }
});

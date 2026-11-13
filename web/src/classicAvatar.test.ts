import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AvatarArtwork } from './components/AvatarArtwork';
import { AVATAR_SHAPES, CLASSIC_AVATAR } from './avatarThemes';
import { createAppearanceStore } from './appearance';
import { communityAvatar, createCommunityMotion } from './components/communityAvatarMotion';

test('idle classic blinks once and releases its frame loop; reduced motion stays still', () => {
  const avatar = communityAvatar('grokbot-blob');
  const poses: string[] = [];
  const motion = createCommunityMotion(
    avatar,
    { state: 'idle', sustain: false, blinkWhenIdle: true },
    (rings) => poses.push(JSON.stringify(rings)),
  );
  let active = true;
  for (let time = 0; time < avatar.blinkSlot('idle') + 100; time += 30)
    active = motion.frame(30, false);
  assert.equal(active, false);
  assert(new Set(poses).size > 2);
  assert.equal(poses.at(-1), JSON.stringify(avatar.pose('idle')));
  assert.equal(motion.frame(0, true), false);
});

test('new devices use Classic black while existing explicit theme choices survive', () => {
  for (const saved of [null, 'pandas', 'companions', 'grokbot-leaf', 'classic']) {
    const store = createAppearanceStore({
      storage: {
        getItem: () =>
          saved &&
          JSON.stringify({
            version: 1,
            theme: 'system',
            accent: 'bot',
            spellCheck: true,
            avatarTheme: saved,
          }),
        setItem: () => {},
      },
    });
    assert.equal(store.getSnapshot().avatarTheme, saved ?? 'classic');
    store.dispose();
  }
});

test('classic keeps six distinct vector silhouettes and light eyes despite stored role colors', () => {
  const bodies = new Set<string>();
  for (const shape of AVATAR_SHAPES) {
    const svg = renderToStaticMarkup(
      React.createElement(AvatarArtwork, {
        theme: 'classic',
        shape,
        color: '#8b5cf6',
        size: 1024,
      }),
    );
    assert.match(svg, /viewBox="0 0 100 100"/);
    assert.match(svg, /width="1024" height="1024"/);
    assert.match(svg, /data-avatar-theme="classic"/);
    assert.match(svg, new RegExp(`data-avatar-source-theme="${CLASSIC_AVATAR.shapes[shape]}"`));
    assert.match(svg, /fill="#1c1c1c"/);
    assert.match(svg, /fill="#fffdf7"/);
    assert.doesNotMatch(svg, /#8b5cf6|<image|<foreignObject/);
    bodies.add(svg.match(/class="avatar-classic-body" d="([^"]+)"/)![1]);
  }
  assert.equal(bodies.size, 6);
});

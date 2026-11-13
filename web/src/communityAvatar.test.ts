import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AVATAR_THEMES,
  COMMUNITY_AVATAR_PACKS,
  avatarTheme,
  type CommunityAvatarTheme,
} from './avatarThemes';
import { AvatarArtwork } from './components/AvatarArtwork';
import {
  communityAvatar,
  createCommunityMotion,
  ringPath,
} from './components/communityAvatarMotion';

const states = ['idle', 'thinking', 'working', 'attention', 'done', 'error'] as const;
test('all forty community characters retain their native paths and finite expression geometry', () => {
  assert.equal(AVATAR_THEMES.length, 46);
  assert.deepEqual(
    COMMUNITY_AVATAR_PACKS.map((pack) => pack.themes.length),
    [22, 18],
  );
  const bodies = new Set<string>();
  for (const pack of COMMUNITY_AVATAR_PACKS)
    for (const theme of pack.themes) {
      const id = theme.id as CommunityAvatarTheme;
      assert.equal(avatarTheme(id), id);
      const avatar = communityAvatar(id);
      bodies.add(avatar.shape.body.path);
      for (const state of states) {
        const rings = avatar.pose(state);
        assert.equal(rings.length, 2);
        assert(
          rings.every(
            (ring) =>
              ring.length === 48 &&
              ring.every((point) => point.length === 2 && point.every(Number.isFinite)),
          ),
        );
        const svg = renderToStaticMarkup(
          React.createElement(AvatarArtwork, {
            theme: id,
            color: '#123456',
            faceMotion: { state, sustain: false, animate: false },
          }),
        );
        assert(svg.includes(ringPath(rings[0])));
        assert.match(svg, /clip-path="url\(#/);
        assert.match(svg, /#123456/);
        assert.doesNotMatch(svg, /<image|<foreignObject|<script|href=|https?:/);
      }
    }
  assert.equal(bodies.size, 40);
  assert.equal(avatarTheme('open-avatar-made-up'), 'classic');
});
test('native rings pass through intermediate geometry and settle exactly for task outcomes', () => {
  for (const theme of ['open-avatar-cat', 'grokbot-leaf'] as const)
    for (const state of ['done', 'error'] as const) {
      const avatar = communityAvatar(theme);
      let frame = avatar.pose('working');
      const animation = createCommunityMotion(
        avatar,
        { state: 'working', sustain: true },
        (next) => {
          frame = next;
        },
      );
      animation.set({ state, sustain: false });
      animation.frame(100, false);
      if (state === 'done' || theme === 'grokbot-leaf')
        assert.notDeepEqual(frame, avatar.pose(state));
      assert.equal(animation.frame(500, false), false);
      assert.deepEqual(frame, avatar.pose(state));
      animation.set({ state: 'working', sustain: true });
      assert.equal(animation.frame(20, true), false);
      assert.deepEqual(frame, avatar.pose('working'));
    }
});

test('retargeting during a blink preserves the displayed rings before easing to the outcome', () => {
  const height = (ring: number[][]) =>
    Math.max(...ring.map((p) => p[1])) - Math.min(...ring.map((p) => p[1]));
  for (const theme of ['open-avatar-cat', 'grokbot-bean', 'grokbot-leaf'] as const) {
    for (const state of ['done', 'error', 'attention'] as const) {
      const avatar = communityAvatar(theme);
      let visible = avatar.pose('working');
      const animation = createCommunityMotion(
        avatar,
        { state: 'working', sustain: true },
        (rings) => {
          visible = rings;
        },
      );
      const halfway = avatar.blinkSlot('working') - avatar.blinkDuration / 2;
      for (let elapsed = 0; elapsed < halfway;) {
        const delta = Math.min(30, halfway - elapsed);
        animation.frame(delta, false);
        elapsed += delta;
      }
      const blinking = visible;
      const native = avatar.pose('working', Math.floor(halfway / avatar.cadence('working')));
      assert(
        Math.abs(height(blinking[0]) / height(native[0]) - 0.04) < 0.0001,
        'blink applies once',
      );
      animation.set({ state, sustain: state === 'attention' });
      animation.frame(0, false);
      assert.deepEqual(
        visible,
        blinking,
        `${theme} ${state}: first frame preserves blink and gaze`,
      );
      animation.frame(100, false);
      assert.notDeepEqual(visible, blinking);
      if (state !== 'attention') {
        assert.equal(animation.frame(500, false), false);
        assert.deepEqual(visible, avatar.pose(state));
      }
      animation.frame(0, true);
      assert.deepEqual(visible, avatar.pose(state));
    }
  }
});

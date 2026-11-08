import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppearanceStore } from './appearance';
import { generatedAvatarTheme, parseCreationPreview } from './creationPreview';

const synthetic = {
  name: 'Space crew',
  motif: 'elephants',
  colors: ['#F7CE86', '#8062C8', '#50C0A6'],
  badge: 'star',
  backdrop: 'halo',
};

test('accepts only structured creation data and rejects asset or style injection', () => {
  assert.deepEqual(generatedAvatarTheme(synthetic)?.colors, ['#f7ce86', '#8062c8', '#50c0a6']);
  for (const altered of [
    { ...synthetic, backdrop: 'url(https://untrusted.example.test)' },
    { ...synthetic, css: '* { display:none }' },
    { ...synthetic, name: 'https://untrusted.example.test' },
    { ...synthetic, colors: ['#FF0000', '#ff0000', '#FFCCFF'] },
  ])
    assert.equal(generatedAvatarTheme(altered), undefined);
  const profile = {
    name: 'Researcher',
    role: 'Check sources',
    description: 'Verifies references',
    instructions: 'Link dated sources.',
    color: '#8062c8',
    avatar: 'gem',
    avatarImageId: null,
  };
  assert.deepEqual(parseCreationPreview('bot', { kind: 'bot', profile }), { kind: 'bot', profile });
  assert.equal(
    parseCreationPreview('bot', { kind: 'bot', profile: { ...profile, avatarImageId: 'other' } }),
    undefined,
  );
});

test('a generated avatar family remains selectable after choosing another preset and reloading', () => {
  let saved = '';
  const storage = {
    getItem: () => saved || null,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const first = createAppearanceStore({ storage });
  const theme = generatedAvatarTheme(synthetic)!;
  first.update({ customAvatarTheme: theme, useCustomAvatarTheme: true });
  assert.equal(first.getSnapshot().useCustomAvatarTheme, true);
  first.update({ avatarTheme: 'chicks', useCustomAvatarTheme: false });
  first.dispose();
  const second = createAppearanceStore({ storage });
  assert.equal(second.getSnapshot().avatarTheme, 'chicks');
  assert.equal(second.getSnapshot().useCustomAvatarTheme, false);
  assert.deepEqual(second.getSnapshot().customAvatarTheme, theme);
  second.update({ useCustomAvatarTheme: true });
  assert.equal(second.getSnapshot().useCustomAvatarTheme, true);
  second.dispose();
});

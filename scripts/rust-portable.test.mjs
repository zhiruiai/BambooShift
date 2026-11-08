import test from 'node:test';
import assert from 'node:assert/strict';
import { portableRustEnvironment } from './rust-portable.mjs';

test('portable builds remap personal paths without changing caller state or development caches', () => {
  const original = {
    CARGO_HOME: '/synthetic/home/project/.tools/cargo',
    CARGO_TARGET_DIR: '/development/cache',
    RUSTFLAGS: '-C opt-level=2',
  };
  const portable = portableRustEnvironment(original, '/synthetic/home/project', '/synthetic/home');
  assert.equal(original.RUSTFLAGS, '-C opt-level=2');
  assert.equal(portable.RUSTFLAGS, undefined);
  assert.equal(portable.CARGO_TARGET_DIR, '/synthetic/home/project/.build/rust-portable');
  const flags = portable.CARGO_ENCODED_RUSTFLAGS.split('\x1f');
  assert.deepEqual(flags.slice(0, 2), ['-C', 'opt-level=2']);
  const mappings = flags.filter((flag) => flag.startsWith('--remap-path-prefix='));
  assert.ok(mappings.includes('--remap-path-prefix=/synthetic/home=/builder'));
  assert.ok(mappings.includes('--remap-path-prefix=/synthetic/home/project=/openbot'));
  assert.equal(mappings.at(-1), '--remap-path-prefix=/synthetic/home/project/.tools/cargo=/cargo');
});
test('encoded flags preserve arguments containing spaces and an explicitly selected portable target', () => {
  const env = portableRustEnvironment(
    {
      CARGO_ENCODED_RUSTFLAGS: '--cfg\x1fvalue="space value"',
      RUSTFLAGS: 'must-not-replace-encoded',
      OPENBOT_PORTABLE_CARGO_TARGET_DIR: '/synthetic/portable-cache',
    },
    '/synthetic/project with spaces',
    '/synthetic/home',
  );
  assert.equal(env.CARGO_TARGET_DIR, '/synthetic/portable-cache');
  const flags = env.CARGO_ENCODED_RUSTFLAGS.split('\x1f');
  assert.equal(flags[1], 'value="space value"');
  assert.ok(flags.includes('--remap-path-prefix=/synthetic/project with spaces=/openbot'));
  assert.ok(!flags.includes('must-not-replace-encoded'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  misplacedTestFile,
  testDependencies,
} from '../../../scripts/source/policy/test-layout.mjs';

test('test cases and their data belong in dedicated test trees on both path styles', () => {
  for (const path of [
    'web/src/__tests__/chat.ts',
    'shared/fixtures/input.json',
    'desktop\\state.test.cjs',
    'server/native/CoreTests.swift',
    'mobile/lib/state_test.dart',
  ])
    assert.ok(misplacedTestFile(path), path);
  for (const path of [
    'tests/web/fixtures/contract.json',
    'server/api/tests/unit/state.rs',
    'mobile/test/state_test.dart',
    'mobile/ios/RunnerTests/RunnerTests.swift',
    'web/src/Workspace.tsx',
  ])
    assert.equal(misplacedTestFile(path), false, path);
});

test('a runtime cannot import test helpers and Cargo can still attach private unit tests', () => {
  const text =
    "export { view } from '../../tests/view'; import('../../tests/options'); require('../../tests/fixtures/input.json')";
  assert.equal(testDependencies({ path: 'web/src/page.ts', text }).length, 3);
  assert.deepEqual(testDependencies({ path: 'tests/web/page.test.ts', text }), []);
  assert.deepEqual(
    testDependencies({
      path: 'server/api/src/state.rs',
      text: '#[cfg(test)]\n#[path = "../tests/unit/state.rs"]\nmod tests;',
    }),
    [],
  );
  assert.equal(
    testDependencies({
      path: 'server/api/src/state.rs',
      text: '#[tokio::test]\nasync fn check() {}',
    }).length,
    1,
  );
});

test('runtime asset references cannot bundle fixture inputs', () => {
  const paths = [
    ['server/api/src/lib.rs', 'include_str!("../tests/input.json")'],
    ['server/api/src/lib.rs', '#[path = "../tests/support/data.rs"]'],
    ['web/src/image.ts', "new URL('../../tests/image.png', import.meta.url)"],
    ['web/src/base.css', "@import '../../tests/layout.css';"],
    ['desktop/ui/icon.css', "background: url('../../tests/icon.png');"],
  ];
  for (const [path, text] of paths) assert.equal(testDependencies({ path, text }).length, 1, path);
});

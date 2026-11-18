import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import test from 'node:test';
import { matchesTestSuite } from '../test-file-selection.mjs';

for (const path of [posix, win32]) {
  test(`browser test selection handles the ${path.sep} path separator`, () => {
    for (const name of ['browser-engine.test.ts', 'browser-download.test.ts']) {
      const file = path.join('tests', 'workers', 'computer-runtime', name);
      assert.ok(matchesTestSuite(file, 'browser'));
      assert.ok(matchesTestSuite(file, 'runtime'));
    }
    for (const file of [
      path.join('tests', 'web', 'browser', 'layout.test.tsx'),
      path.join('tests', 'web', 'chat.browser.test.ts'),
    ]) {
      assert.ok(matchesTestSuite(file, 'browser'));
      assert.ok(!matchesTestSuite(file, 'web'));
    }
    const unit = path.join('tests', 'workers', 'unit.test.mjs');
    assert.ok(matchesTestSuite(unit, 'runtime'));
    assert.ok(!matchesTestSuite(unit, 'browser'));
    assert.ok(!matchesTestSuite(path.join('tests', 'web', 'browser', 'fixture.ts'), 'browser'));
  });
}

import assert from 'node:assert/strict';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { fixture } from './computer-screen-lifecycle.fixture.js';

test('a journal write failure after Linux replacement cannot publish it and explicit restart resumes the same generation', async () => {
  const f = await fixture();
  const path = join(f.stateDir, f.configuration.screens[0].id + '.json');
  let moved = false;
  try {
    const req = await f.request();
    f.controls.afterDriver = async () => {
      await rename(path, path + '.backup');
      moved = true;
      await mkdir(path);
    };
    const blocked = await f.call(0, '/lifecycle', req, req.expectedRevision);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.status, 'blocked');
    assert.notEqual(blocked.json.phase, 'complete');
    assert.equal(f.controls.starts, 1);
    await assert.rejects(f.inventory(), /写入未确认/);
    await rm(path, { recursive: true });
    await rename(path + '.backup', path);
    moved = false;
    f.controls.afterDriver = undefined;
    await f.restart();
    assert.equal((await f.inventory()).screens[0].available, false);
    const completed = await f.call(0, '/lifecycle', req, req.expectedRevision);
    assert.equal(completed.status, 200);
    assert.deepEqual(completed.json.next, blocked.json.next);
    assert.equal(f.controls.starts, 1, 'the already-created generation is adopted, not replaced');
  } finally {
    if (moved) {
      await rm(path, { recursive: true, force: true });
      await rename(path + '.backup', path);
    }
    await f.close();
  }
});

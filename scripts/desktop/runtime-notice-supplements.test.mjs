import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDependencyNotices } from '../dependency-notices.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('published proxy implementation retains its exact inherited MIT notice', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'runtime-notice-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const packagePath = 'node_modules/proxy-agent-negotiate';
  const summary = await collectDependencyNotices({
    sourceRoot: root,
    output: join(temporary, 'notices'),
    npmScope: 'bundled-runtime',
    npmPackages: [{ packagePath, name: 'proxy-agent-negotiate', version: '1.1.0' }],
    cargoMetadata: {
      host: 'synthetic-host',
      metadata: { packages: [], workspace_members: [], resolve: { nodes: [] } },
    },
  });
  assert.deepEqual(summary.missing, []);
  const index = JSON.parse(await readFile(join(temporary, 'notices/index.json')));
  const notice = index.packages[0].files.find(
    (entry) => entry.sha256 === '71368fd0f5b4129191e9afcd1e1ef2dc89a9090d3e4d80bbab92dafd032b3bef',
  );
  assert.ok(notice, 'the verified source notice must survive actual runtime collection');
  assert.deepEqual(
    await readFile(join(temporary, 'notices', notice.path)),
    await readFile(join(root, 'legal/third-party/proxy-agent-negotiate-1.1.0/LICENSE')),
  );
});

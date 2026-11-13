import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { copyDesktopRuntime } from './runtime-copy.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bambooshift-runtime-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const destination = join(directory, 'relocated');
  await mkdir(source);
  return { directory, source, destination };
}

test('copied npm bin and nested relative links run after the build source is removed', async (t) => {
  const { source, destination } = await fixture(t);
  const modules = join(source, 'node_modules');
  await mkdir(join(modules, '.bin'), { recursive: true });
  await mkdir(join(modules, 'fixture/bin'), { recursive: true });
  await writeFile(join(modules, 'fixture/bin/cli.cjs'), "console.log('relocated fixture');\n");
  await symlink('../fixture/bin/cli.cjs', join(modules, '.bin/fixture'));
  await symlink('fixture', join(modules, '.bin/alias'));
  await symlink('fixture', join(modules, 'module-alias'), 'dir');

  await copyDesktopRuntime(source, destination);
  await rm(source, { recursive: true });

  const copied = join(destination, 'node_modules');
  assert.equal(await readlink(join(copied, '.bin/fixture')), '../fixture/bin/cli.cjs');
  assert.equal(await readlink(join(copied, '.bin/alias')), 'fixture');
  assert.equal(await readlink(join(copied, 'module-alias')), 'fixture');
  for (const path of ['.bin/fixture', '.bin/alias', 'module-alias/bin/cli.cjs']) {
    const { stdout } = await execute(process.execPath, [join(copied, path)]);
    assert.equal(stdout.trim(), 'relocated fixture');
  }
});

test('runtime copy refuses absolute, external, broken and cyclic links before copying', async (t) => {
  for (const kind of ['absolute', 'external', 'indirect-external', 'broken', 'cyclic']) {
    await t.test(kind, async (t) => {
      const { directory, source, destination } = await fixture(t);
      await writeFile(join(source, 'target'), 'inside');
      await writeFile(join(directory, 'outside'), 'outside');
      const target = {
        absolute: join(source, 'target'),
        external: '../outside',
        'indirect-external': 'second',
        broken: 'missing',
        cyclic: 'second',
      }[kind];
      await symlink(target, join(source, 'first'));
      if (kind === 'cyclic') await symlink('first', join(source, 'second'));
      if (kind === 'indirect-external') await symlink('../outside', join(source, 'second'));
      await assert.rejects(copyDesktopRuntime(source, destination), /runtime.*symlink/i);
      await assert.rejects(readFile(join(destination, 'target')), { code: 'ENOENT' });
    });
  }
});

test('runtime copy requires a real source directory and does not replace destination files', async (t) => {
  const { directory, source, destination } = await fixture(t);
  await writeFile(join(source, 'target'), 'incoming');
  const alias = join(directory, 'alias');
  await symlink('source', alias, 'dir');
  await assert.rejects(copyDesktopRuntime(alias, destination), /real directory/);
  await assert.rejects(copyDesktopRuntime(alias + sep, destination), /real directory/);
  await assert.rejects(copyDesktopRuntime(join(source, 'target'), destination), /real directory/);
  await mkdir(destination);
  await writeFile(join(destination, 'target'), 'existing');
  await assert.rejects(copyDesktopRuntime(source, destination), { code: 'ERR_FS_CP_EEXIST' });
  assert.equal(await readFile(join(destination, 'target'), 'utf8'), 'existing');
});

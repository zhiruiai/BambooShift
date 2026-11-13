import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  argumentsForCheck,
  digest,
  inspectPersonalPackage,
  packageHashes,
} from './personal-package-inputs.mjs';
import { runPersonalProbe } from './personal-package-process.mjs';

export async function checkPersonalPackage(resources) {
  const input = await inspectPersonalPackage(resources);
  const hashes = await packageHashes(input.paths);
  const supervisor = extractFile(input.paths.asar, 'local-runtime.cjs');
  assert.ok(supervisor.length > 0 && supervisor.length < 64 * 1024);
  const temporary = await mkdtemp(join(tmpdir(), 'bambooshift-personal-package-'));
  let cleanupConfirmed = true;
  try {
    await writeFile(join(temporary, 'local-runtime.cjs'), supervisor, { mode: 0o600, flag: 'wx' });
    const result = await runPersonalProbe(
      input.paths.node,
      [
        fileURLToPath(new URL('./personal-package-runner.mjs', import.meta.url)),
        input.resources,
        temporary,
      ],
      {
        cwd: temporary,
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: tmpdir() },
      },
    );
    assert.equal(result.passed, true);
    assert.deepEqual(
      await packageHashes(input.paths),
      hashes,
      'Package inputs changed during acceptance.',
    );
    return {
      ...result,
      recordedAt: new Date().toISOString(),
      packageHashes: { ...hashes, supervisor: digest(supervisor) },
      checkedInputHashesUnchanged: true,
      temporaryProfileRemoved: true,
    };
  } catch (error) {
    if (error.code === 'ACCEPTANCE_CLEANUP_UNKNOWN') cleanupConfirmed = false;
    throw error;
  } finally {
    if (cleanupConfirmed) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsForCheck(process.argv.slice(2));
    if (options.help)
      console.log(
        'Usage: node scripts/desktop/check-personal-package.mjs --resources <unpacked-app-resources>\nRuns an isolated synthetic personal workspace with host control disabled. Does not test Electron UI.',
      );
    else console.log(JSON.stringify(await checkPersonalPackage(options.resources), null, 2));
  } catch (error) {
    console.error(
      /^Personal package acceptance (failed at [a-z-]+|interrupted|exceeded its deadline)\.$/.test(
        error.message,
      )
        ? error.message
        : 'Personal package acceptance failed. Check the package target, contents and command arguments.',
    );
    process.exitCode = 1;
  }
}

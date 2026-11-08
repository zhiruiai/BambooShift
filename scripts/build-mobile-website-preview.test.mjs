import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('Flutter website preview asset matches the shared renderer', async () => {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./build-mobile-website-preview.mjs', import.meta.url)),
    '--check',
  ]);
});

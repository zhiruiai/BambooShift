import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildMacAccessibilityHelper } from './desktop/macos-accessibility-helper.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(sourceRoot, 'data/native');
try {
  const executable = await buildMacAccessibilityHelper({
    sourceRoot,
    output,
    testOutput: output,
  });
  console.log(`Built ${executable}`);
  console.log('No screen was captured, no input was sent, and no permission prompt was requested.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

import { cargo } from './rust-toolchain.mjs';
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--release'))
  throw new Error('Usage: npm run backend:build -- [--release]');
await cargo('build', ['--bins', ...args]);

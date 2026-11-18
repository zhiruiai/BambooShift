import { cargo } from '../scripts/rust-toolchain.mjs';
process.env.OPENBOT_NODE ||= process.execPath;
await cargo('test', process.argv.slice(2));

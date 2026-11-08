import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { root } from './rust-toolchain.mjs';

if (process.argv.length > 2)
  throw new Error(
    'Use OPENBOT_DATA_DIR / OPENBOT_SERVER_CONFIG / PORT to select local deployment paths.',
  );
const output = resolve(process.env.OPENBOT_SERVER_CONFIG || 'config/private/server.private.json');
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be between 1024 and 65535.');
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const file = await open(output, 'wx', 0o600);
try {
  await file.writeFile(
    JSON.stringify(
      {
        dataDir: resolve(process.env.OPENBOT_DATA_DIR || 'data'),
        bind: `127.0.0.1:${port}`,
        publicOrigin: null,
        webOrigin: 'http://127.0.0.1:5173',
        operations: {
          bind: '127.0.0.1:3002',
          publicOrigin: null,
          webOrigin: 'http://127.0.0.1:5174',
        },
        runtimeDir: root,
        nodeBinary: process.execPath,
      },
      null,
      2,
    ) + '\n',
  );
  await file.sync();
} finally {
  await file.close();
}
console.log(
  `Private local configuration created: ${output}. Existing files are never overwritten.`,
);

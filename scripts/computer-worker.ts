import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startComputerWorker } from '../server/workers/computer-runtime/http/cli.js';
export { isAuthorized, createComputerWorker } from '../server/workers/computer-runtime/http/worker.js';
export { createComputerWorkerPool } from '../server/workers/computer-runtime/http/pool.js';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await startComputerWorker();

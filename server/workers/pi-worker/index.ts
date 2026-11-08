import { parseCommand, MAX_FRAME_BYTES } from './protocol.js';
import { WorkerSession } from './session.js';

let worker: WorkerSession | undefined,
  secret = '',
  pending = Buffer.alloc(0),
  started = false,
  activeRunId = '';
let output = Promise.resolve();
let queuedBytes = 0,
  overflowing = false;
function send(event: Record<string, unknown>) {
  if (overflowing) return;
  const safe = JSON.stringify(event, (_key, value) =>
    secret && typeof value === 'string' ? value.split(secret).join('[redacted]') : value,
  );
  const bytes = Buffer.byteLength(safe) + 1;
  if (bytes > MAX_FRAME_BYTES || queuedBytes + bytes > MAX_FRAME_BYTES * 4) {
    overflowing = true;
    void worker?.command({ type: 'abort', runId: String(event.runId) });
    return;
  }
  queuedBytes += bytes;
  output = output.then(
    () =>
      new Promise<void>((resolve, reject) =>
        process.stdout.write(safe + '\n', (error) => {
          queuedBytes -= bytes;
          if (error) reject(error);
          else resolve();
        }),
      ),
  );
  void output.catch(() => {
    process.exitCode = 1;
    process.stdin.destroy();
  });
}
function receive(line: string) {
  try {
    const command = parseCommand(line);
    if (command.type === 'start') {
      if (started) throw Error('This process already owns a run.');
      started = true;
      secret = command.profile.apiKey || '';
      activeRunId = command.runId;
      worker = new WorkerSession(command, send);
      void worker.execute().finally(async () => {
        process.stdin.destroy();
        await output;
      });
    } else {
      if (!worker) throw Error('No active run.');
      void worker
        .command(command)
        .catch(() =>
          send({ type: 'protocol_error', code: 'INVALID_COMMAND', runId: command.runId }),
        );
    }
  } catch {
    send({ version: 1, type: 'protocol_error', code: 'INVALID_COMMAND' });
  }
}
process.stdin.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  let newline: number;
  while ((newline = pending.indexOf(10)) !== -1) {
    const line = pending.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    pending = pending.subarray(newline + 1);
    if (line) receive(line);
  }
  if (pending.length > MAX_FRAME_BYTES) {
    send({ version: 1, type: 'protocol_error', code: 'FRAME_TOO_LARGE' });
    process.stdin.destroy();
  }
});
const close = () => {
  if (worker) void worker.command({ type: 'close', runId: activeRunId }).catch(() => {});
};
// EOF, signals and parent failure all cancel the process-owned run.
process.stdin.on('end', close);
process.stdin.on('close', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);

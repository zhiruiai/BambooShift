import { randomUUID } from 'node:crypto';
import type { StartRun, WorkerCommand } from './protocol.js';
import { MAX_RUN_TIMEOUT_MS } from './protocol.js';
import { createPluginHost, type WorkerPluginHost } from '../plugin-runtime/host.js';
import type { EngineSession } from '../plugin-runtime/engines.js';
import type { TrustedBundledPlugin } from '../plugin-runtime/bundled.js';

type PendingTool = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};
export class WorkerSession {
  private controller = new AbortController();
  private session?: EngineSession;
  private tools = new Map<string, PendingTool>();
  private closing = false;
  private ended = false;
  private timedOut = false;
  private inputs = new Map<string, string>();
  constructor(
    private run: StartRun,
    private send: (event: Record<string, unknown>) => void,
    private readonly bundled?: readonly TrustedBundledPlugin[],
  ) {}

  private emit(event: Record<string, unknown>) {
    if (!this.ended) this.send({ version: 1, runId: this.run.runId, ...event });
  }
  async execute() {
    let status = 'error';
    let plugins: WorkerPluginHost | undefined;
    // Rust owns the shared deadline and authority cancellation. This bounded
    // worker timer prevents a lost host from leaving pending tools alive forever.
    const deadline = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
      this.rejectTools();
      void this.session?.abort().catch(() => {});
    }, this.run.timeoutMs ?? MAX_RUN_TIMEOUT_MS);
    deadline.unref();
    try {
      plugins = await createPluginHost(
        {
          tools: this.run.tools,
          signal: this.controller.signal,
          requestTool: (callId, name, args, signal) => this.requestTool(callId, name, args, signal),
        },
        this.bundled,
      );
      const session = plugins.createEngine(this.run.engine ?? 'pi', {
        run: this.run,
        signal: this.controller.signal,
        onEvent: (event) => {
          if (event.type === 'message_start' && event.message.role === 'user') {
            const text =
              typeof event.message.content === 'string'
                ? event.message.content
                : event.message.content
                    .filter((part) => part.type === 'text')
                    .map((part) => ('text' in part ? part.text : ''))
                    .join('');
            const inputId = this.inputs.get(text);
            if (inputId) {
              this.inputs.delete(text);
              this.emit({ type: 'input_delivered', inputId });
            }
          }
          this.emit({ type: 'event', event });
        },
      });
      this.session = session;
      await session.start();
      this.controller.signal.throwIfAborted();
      this.emit({ type: 'started' });
      await session.prompt(this.run.prompt);
      this.controller.signal.throwIfAborted();
      status = 'completed';
    } catch {
      status = this.controller.signal.aborted && !this.timedOut ? 'cancelled' : 'error';
      this.emit({
        type: 'error',
        code: this.timedOut
          ? 'RUN_DEADLINE_EXCEEDED'
          : status === 'cancelled'
            ? 'RUN_CANCELLED'
            : 'RUN_FAILED',
      });
    } finally {
      clearTimeout(deadline);
      this.closing = true;
      this.rejectTools();
      try {
        // Engine sessions are owned by their Cordis plugin. Its tracked cleanup
        // awaits initialization, abort, and disposal along with all other plugins.
        await plugins?.dispose();
      } catch {
        status = 'error';
        this.emit({ type: 'error', code: 'PLUGIN_CLEANUP_FAILED' });
      } finally {
        this.emit({ type: 'settled', status });
        this.ended = true;
      }
    }
  }
  private requestTool(
    toolCallId: string,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    this.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = () => this.finishTool(callId, undefined, 'Tool request cancelled.');
      this.tools.set(callId, {
        resolve: (value) => {
          signal?.removeEventListener('abort', fail);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', fail);
          reject(error);
        },
      });
      signal?.addEventListener('abort', fail, { once: true });
      this.emit({ type: 'tool_call', callId, toolCallId, name, arguments: args });
    });
  }
  private finishTool(callId: string, result?: unknown, error?: string) {
    const pending = this.tools.get(callId);
    if (!pending) return;
    this.tools.delete(callId);
    if (error) pending.reject(Error(error));
    else pending.resolve(result);
  }
  private rejectTools() {
    for (const callId of this.tools.keys()) this.finishTool(callId, undefined, 'Run ended.');
  }
  async command(command: Exclude<WorkerCommand, StartRun>) {
    if (command.runId !== this.run.runId || this.closing || this.ended)
      throw Error('Stale run command.');
    if (command.type === 'tool_result')
      this.finishTool(command.callId, command.result, command.error);
    else if (command.type === 'abort' || command.type === 'close') {
      this.controller.abort();
      this.rejectTools();
      await this.session?.abort();
    } else if (command.type === 'steer' || command.type === 'follow_up') {
      if (!this.session || this.controller.signal.aborted) throw Error('Run is not ready.');
      if (command.inputId) this.inputs.set(command.text, command.inputId);
      if (command.type === 'steer') await this.session.steer(command.text);
      else await this.session.followUp(command.text);
    }
  }
}

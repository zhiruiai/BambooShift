import { randomUUID } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createWorkerModel } from './model.js';
import type { StartRun, WorkerCommand } from './protocol.js';

type PendingTool = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class WorkerSession {
  private controller = new AbortController();
  private session?: AgentSession;
  private tools = new Map<string, PendingTool>();
  private ended = false;
  private inputs = new Map<string, string>();
  constructor(
    private run: StartRun,
    private send: (event: Record<string, unknown>) => void,
  ) {}

  private emit(event: Record<string, unknown>) {
    if (!this.ended) this.send({ version: 1, runId: this.run.runId, ...event });
  }
  async execute() {
    let status = 'error';
    try {
      const pi = await import('@earendil-works/pi-coding-agent');
      const { runtime, model } = await createWorkerModel(pi, this.run, this.controller.signal);
      this.controller.signal.throwIfAborted();
      const loader = new pi.DefaultResourceLoader({
        cwd: this.run.cwd,
        agentDir: this.run.cwd,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => this.run.systemPrompt,
      });
      await loader.reload();
      this.controller.signal.throwIfAborted();
      const { session } = await pi.createAgentSession({
        cwd: this.run.cwd,
        agentDir: this.run.cwd,
        model,
        modelRuntime: runtime,
        thinkingLevel: 'off',
        tools: this.run.tools.map((tool) => tool.name),
        resourceLoader: loader,
        customTools: this.run.tools.map((tool) => ({
          ...tool,
          label: tool.name,
          parameters: tool.parameters as any,
          execute: async (toolCallId: string, args: unknown, signal?: AbortSignal) =>
            this.requestTool(toolCallId, tool.name, args, signal),
        })),
        sessionManager: pi.SessionManager.inMemory(this.run.cwd),
        settingsManager: pi.SettingsManager.inMemory({
          retry: { enabled: false },
          compaction: { enabled: false },
        }),
      });
      this.session = session;
      if (this.controller.signal.aborted) {
        await session.abort();
        throw Error('Run cancelled.');
      }
      const unsubscribe = session.subscribe((event) => {
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
      });
      try {
        this.emit({ type: 'started' });
        await session.prompt(this.run.prompt, { expandPromptTemplates: false });
        this.controller.signal.throwIfAborted();
        const last = session.messages.filter((message) => message.role === 'assistant').at(-1);
        if (!last || last.stopReason === 'error' || last.stopReason === 'aborted')
          throw Error('Model run failed.');
        status = 'completed';
      } finally {
        unsubscribe();
      }
    } catch {
      status = this.controller.signal.aborted ? 'cancelled' : 'error';
      this.emit({ type: 'error', code: status === 'cancelled' ? 'RUN_CANCELLED' : 'RUN_FAILED' });
    } finally {
      this.rejectTools();
      this.session?.dispose();
      this.emit({ type: 'settled', status });
      this.ended = true;
    }
  }
  private requestTool(toolCallId: string, name: string, args: unknown, signal?: AbortSignal): Promise<any> {
    this.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = () => this.finishTool(callId, undefined, 'Tool request cancelled.');
      const timer = setTimeout(
        () => this.finishTool(callId, undefined, 'Tool request expired.'),
        300000,
      );
      timer.unref();
      this.tools.set(callId, {
        resolve: (value) => {
          signal?.removeEventListener('abort', fail);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', fail);
          reject(error);
        },
        timer,
      });
      signal?.addEventListener('abort', fail, { once: true });
      this.emit({ type: 'tool_call', callId, toolCallId, name, arguments: args });
    });
  }
  private finishTool(callId: string, result?: unknown, error?: string) {
    const pending = this.tools.get(callId);
    if (!pending) return;
    this.tools.delete(callId);
    clearTimeout(pending.timer);
    if (error) pending.reject(Error(error));
    else pending.resolve(result);
  }
  private rejectTools() {
    for (const callId of this.tools.keys()) this.finishTool(callId, undefined, 'Run ended.');
  }
  async command(command: Exclude<WorkerCommand, StartRun>) {
    if (command.runId !== this.run.runId || this.ended) throw Error('Stale run command.');
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

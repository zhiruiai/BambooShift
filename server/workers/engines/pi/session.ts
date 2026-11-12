import type {
  AgentSession,
  ToolDefinition,
  AgentToolResult,
} from '@earendil-works/pi-coding-agent';
import type { EngineOptions, EngineSession } from '../../plugin-runtime/engines.js';
import type { RustToolBridge, WorkerToolRegistry } from '../../plugin-runtime/services.js';
import { createWorkerModel } from './model.js';
import { toWorkerEvent } from './events.js';

/** All Pi SDK objects stay behind this engine boundary. Rust remains the tool authority. */
export class PiEngineSession implements EngineSession {
  private readonly cancellation = new AbortController();
  private readonly signal: AbortSignal;
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private initializing?: Promise<void>;
  private aborting?: Promise<void>;
  private stopping?: Promise<void>;
  constructor(
    private readonly options: EngineOptions,
    private readonly bridge: RustToolBridge,
    private readonly tools: WorkerToolRegistry,
  ) {
    this.signal = AbortSignal.any([options.signal, this.cancellation.signal]);
  }
  start(): Promise<void> {
    return (this.initializing ??= this.initialize());
  }
  private async initialize(): Promise<void> {
    this.signal.throwIfAborted();
    const pi = await import('@earendil-works/pi-coding-agent');
    this.signal.throwIfAborted();
    const run = this.options.run;
    const { runtime, model } = await createWorkerModel(pi, run, this.signal);
    this.signal.throwIfAborted();
    const loader = new pi.DefaultResourceLoader({
      cwd: run.cwd,
      agentDir: run.cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => run.systemPrompt,
    });
    await loader.reload();
    this.signal.throwIfAborted();
    const available = new Set(this.tools.names());
    const definitions = this.bridge.definitions().filter((tool) => available.has(tool.name));
    const customTools: ToolDefinition[] = definitions.map((tool) => ({
      ...tool,
      label: tool.name,
      parameters: tool.parameters as ToolDefinition['parameters'],
      execute: async (callId, args, signal) =>
        (await this.tools.invoke(tool.name, callId, args, signal)) as AgentToolResult<unknown>,
    }));
    const { session } = await pi.createAgentSession({
      cwd: run.cwd,
      agentDir: run.cwd,
      model,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      tools: definitions.map((tool) => tool.name),
      resourceLoader: loader,
      customTools,
      sessionManager: pi.SessionManager.inMemory(run.cwd),
      settingsManager: pi.SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    });
    this.session = session;
    this.signal.throwIfAborted();
    this.unsubscribe = session.subscribe((event) => {
      if (this.signal.aborted || this.stopping) return;
      const adapted = toWorkerEvent(event);
      if (adapted) this.options.onEvent(adapted);
    });
  }
  private ready(): AgentSession {
    this.signal.throwIfAborted();
    if (!this.session || this.stopping) throw Error('Engine session is unavailable.');
    return this.session;
  }
  async prompt(text: string): Promise<void> {
    const session = this.ready();
    await session.prompt(text, { expandPromptTemplates: false });
    this.signal.throwIfAborted();
    const last = session.messages.filter((message) => message.role === 'assistant').at(-1);
    if (!last || last.stopReason === 'error' || last.stopReason === 'aborted')
      throw Error('Model run failed.');
  }
  async steer(text: string): Promise<void> {
    await this.ready().steer(text);
  }
  async followUp(text: string): Promise<void> {
    await this.ready().followUp(text);
  }
  abort(): Promise<void> {
    this.cancellation.abort();
    return (this.aborting ??= (async () => {
      // Initialization may acquire a session after cancellation. Await and release it too.
      await this.initializing?.catch(() => {});
      await this.session?.abort();
    })());
  }
  dispose(): Promise<void> {
    return (this.stopping ??= (async () => {
      try {
        await this.abort();
      } finally {
        try {
          this.unsubscribe?.();
        } finally {
          await this.session?.dispose();
        }
      }
    })());
  }
}

import type { StartRun } from '../agent-runtime/protocol.js';

/** The v1 message subset consumed by Rust persistence and input delivery. */
export type EngineMessageEvent = {
  type: 'message_start' | 'message_update' | 'message_end';
  message: {
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string }[];
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  };
};
/** Preserve real tool completion/failure observations alongside the authoritative Rust result. */
export type EngineToolEndEvent = {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  durationMs?: number;
  parentToolCallId?: string;
};
export type EngineEvent = EngineMessageEvent | EngineToolEndEvent;
export type EngineOptions = {
  run: StartRun;
  signal: AbortSignal;
  onEvent(event: EngineEvent): void;
};
export interface EngineSession {
  start(): Promise<void>;
  /** Resolves only on a successful model turn; model errors and aborts must reject. */
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Idempotent; the owning Cordis plugin registers this with PluginCleanup. */
  dispose(): Promise<void>;
}
export type EngineFactory = (options: EngineOptions) => EngineSession;

/** Source-registered providers only. An identifier is never interpreted as an import path. */
export class WorkerEngineRegistry {
  private readonly factories = new Map<string, EngineFactory>();
  private closed = false;
  register(id: string, factory: EngineFactory): () => void {
    if (this.closed) throw Error('Engine registry is closed.');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || this.factories.has(id))
      throw Error('Invalid or duplicate engine provider.');
    this.factories.set(id, factory);
    return () => {
      if (this.factories.get(id) === factory) this.factories.delete(id);
    };
  }
  create(id: string, options: EngineOptions): EngineSession {
    if (this.closed || options.signal.aborted) throw Error('Engine registry is closed.');
    const factory = this.factories.get(id);
    if (!factory) throw Error('Unknown bundled engine provider.');
    return factory(options);
  }
  close(): void {
    this.closed = true;
    this.factories.clear();
  }
}

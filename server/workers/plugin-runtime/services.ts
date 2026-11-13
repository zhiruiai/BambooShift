import type { Context } from '@cordisjs/core';
import type { ToolSpec } from '../agent-runtime/protocol.js';

export type RustToolRequest = (
  toolCallId: string,
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<any>;
export type ToolHandler = (
  toolCallId: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

function cancelled(): Error {
  return new Error('Plugin tool call cancelled.');
}

/** Even a transport that ignores cancellation cannot return a late successful result. */
async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw cancelled();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    if (signal.aborted) throw cancelled();
    // Dispatch synchronously, but capture throws so both race branches gain rejection handlers.
    const running = new Promise<T>((resolve) => resolve(work()));
    const result = await Promise.race([stopped, running]);
    if (signal.aborted) throw cancelled();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export class RustToolBridge {
  private readonly admitted: Map<string, ToolSpec>;
  constructor(
    tools: readonly ToolSpec[],
    private readonly request: RustToolRequest,
    private readonly signal: AbortSignal,
  ) {
    if (tools.length > 128) throw Error('Too many worker tools.');
    this.admitted = new Map();
    for (const tool of tools) {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) ||
        this.admitted.has(tool.name) ||
        typeof tool.description !== 'string' ||
        !tool.description.trim() ||
        tool.parameters?.type !== 'object'
      ) {
        throw Error('Invalid worker tool contract.');
      }
      this.admitted.set(tool.name, structuredClone(tool));
    }
  }
  definitions(): ToolSpec[] {
    return [...this.admitted.values()].map((tool) => structuredClone(tool));
  }
  has(name: string): boolean {
    return this.admitted.has(name);
  }
  async invoke(
    toolCallId: string,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.has(name)) throw Error('Tool was not admitted by Rust.');
    const combined = AbortSignal.any([this.signal, signal]);
    return abortable(combined, () => this.request(toolCallId, name, args, combined));
  }
}

export class WorkerToolRegistry {
  private readonly entries = new Map<string, { handler: ToolHandler; cancel: AbortController }>();
  private closed = false;
  constructor(
    private readonly authority: RustToolBridge,
    private readonly signal: AbortSignal,
  ) {}
  register(name: string, handler: ToolHandler): () => void {
    if (this.closed || this.signal.aborted) throw Error('Plugin host is closed.');
    if (!this.authority.has(name)) throw Error('Tool was not admitted by Rust.');
    if (this.entries.has(name)) throw Error('Worker tool is already registered.');
    const entry = { handler, cancel: new AbortController() };
    this.entries.set(name, entry);
    return () => {
      if (this.entries.get(name) !== entry) return;
      this.entries.delete(name);
      entry.cancel.abort();
    };
  }
  names(): string[] {
    return [...this.entries.keys()];
  }
  async invoke(
    name: string,
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const entry = this.entries.get(name);
    if (this.closed || !entry) throw Error('Worker tool is unavailable.');
    const combined = AbortSignal.any([
      this.signal,
      entry.cancel.signal,
      ...(signal ? [signal] : []),
    ]);
    return abortable(combined, () => entry.handler(toolCallId, args, combined));
  }
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) entry.cancel.abort();
    this.entries.clear();
  }
}

/** Cordis 3 disposes effects synchronously; explicitly track asynchronous resource cleanup. */
export class PluginCleanup {
  private readonly pending = new Set<Promise<void>>();
  private failed = false;
  onDispose(ctx: Context, cleanup: () => void | Promise<void>): void {
    ctx.on('dispose', () => {
      let result: void | Promise<void>;
      try {
        result = cleanup();
      } catch {
        this.failed = true;
        return;
      }
      const pending = Promise.resolve(result)
        .catch(() => {
          this.failed = true;
        })
        .finally(() => this.pending.delete(pending));
      this.pending.add(pending);
    });
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
    if (this.failed) throw Error('Plugin cleanup failed.');
  }
}

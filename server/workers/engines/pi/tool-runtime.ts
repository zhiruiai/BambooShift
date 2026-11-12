import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { createPluginHost, type PluginHostOptions } from '../../plugin-runtime/host.js';

export type PiToolRuntime = { customTools: ToolDefinition[]; dispose(): Promise<void> };

export async function createPiToolRuntime(options: PluginHostOptions): Promise<PiToolRuntime> {
  const host = await createPluginHost(options);
  return {
    customTools: host.definitions().map((tool) => ({
      ...tool,
      label: tool.name,
      parameters: tool.parameters as ToolDefinition['parameters'],
      execute: async (toolCallId, args, signal) =>
        (await host.invoke(tool.name, toolCallId, args, signal)) as AgentToolResult<unknown>,
    })),
    dispose: () => host.dispose(),
  };
}

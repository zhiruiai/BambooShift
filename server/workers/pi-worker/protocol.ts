export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_START_BYTES = 2 * 1024 * 1024;
export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type StartRun = {
  type: 'start';
  version: 1;
  runId: string;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  profile: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
    vision?: boolean;
  };
  tools: ToolSpec[];
};
export type WorkerCommand =
  | StartRun
  | { type: 'steer' | 'follow_up'; runId: string; text: string; inputId?: string }
  | { type: 'abort' | 'close'; runId: string }
  | { type: 'tool_result'; runId: string; callId: string; result?: unknown; error?: string };

const opaque = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === 'string' &&
  value.length <= maximum &&
  (empty || !!value.trim()) &&
  !value.includes('\0');

export function parseCommand(line: string): WorkerCommand {
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw Error('Frame exceeds protocol limit.');
  const command = JSON.parse(line);
  if (!command || typeof command !== 'object' || Array.isArray(command) || !opaque(command.runId))
    throw Error('Invalid command identity.');
  if (command.type === 'start') {
    if (Buffer.byteLength(line) > MAX_START_BYTES) throw Error('Run configuration exceeds protocol limit.');
    const profile = command.profile;
    if (
      command.version !== PROTOCOL_VERSION ||
      !text(command.cwd, 4096) ||
      !text(command.systemPrompt, 128000, true) ||
      !text(command.prompt, 256000) ||
      !profile ||
      !opaque(profile.provider) ||
      !text(profile.model, 256) ||
      (profile.apiKey !== undefined && !text(profile.apiKey, 16384, true)) ||
      (profile.baseUrl !== undefined && !text(profile.baseUrl, 4096, true)) ||
      !Array.isArray(command.tools) ||
      command.tools.length > 128
    )
      throw Error('Invalid run configuration.');
    const names = new Set<string>();
    for (const tool of command.tools) {
      if (
        !tool ||
        !opaque(tool.name) ||
        names.has(tool.name) ||
        !text(tool.description, 16000) ||
        !tool.parameters ||
        typeof tool.parameters !== 'object' ||
        Array.isArray(tool.parameters) ||
        tool.parameters.type !== 'object'
      )
        throw Error('Invalid tool contract.');
      names.add(tool.name);
    }
  } else if (command.type === 'steer' || command.type === 'follow_up') {
    if (!text(command.text, 256000) || (command.inputId !== undefined && !opaque(command.inputId)))
      throw Error('Invalid follow-up input.');
  } else if (command.type === 'tool_result') {
    if (!opaque(command.callId) || (command.error !== undefined && !text(command.error, 4096)))
      throw Error('Invalid tool result.');
  } else if (command.type !== 'abort' && command.type !== 'close') throw Error('Unknown command.');
  return command as WorkerCommand;
}

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { EngineEvent, EngineMessageEvent } from '../../plugin-runtime/engines.js';

/** Preserve the v1 Rust message/usage contract without exposing arbitrary SDK events. */
export function toWorkerEvent(event: AgentSessionEvent): EngineEvent | undefined {
  if (event.type === 'tool_execution_end') {
    const { toolCallId, toolName, result, isError, durationMs, parentToolCallId } = event;
    return {
      type: event.type,
      toolCallId,
      toolName,
      result,
      isError,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    };
  }
  if (
    event.type !== 'message_start' &&
    event.type !== 'message_update' &&
    event.type !== 'message_end'
  )
    return;
  const message = event.message;
  if (message.role !== 'assistant' && message.role !== 'user') return;
  const content =
    typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content.flatMap((part) =>
          part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : [],
        );
  const result: EngineMessageEvent = { type: event.type, message: { role: message.role, content } };
  if (message.role === 'assistant' && message.usage) {
    const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
    result.message.usage = { input, output, cacheRead, cacheWrite, totalTokens };
  }
  return result;
}

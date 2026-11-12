export const conversationExportLimit = 10 * 1024 * 1024;

export type ConversationExport = {
  conversationId: string;
  filename: string;
  content: string;
  messageCount: number;
  exportedAt: string;
  complete: true;
};

/** A partial or mismatched response must never be offered as a complete transcript. */
export function conversationExport(value: unknown, id: string): ConversationExport {
  const data = value as Partial<ConversationExport> | null;
  if (
    !data ||
    data.conversationId !== id ||
    data.complete !== true ||
    typeof data.content !== 'string' ||
    new TextEncoder().encode(data.content).byteLength > conversationExportLimit ||
    typeof data.filename !== 'string' ||
    !/^conversation-[a-zA-Z0-9-]+\.md$/.test(data.filename) ||
    typeof data.messageCount !== 'number' ||
    !Number.isSafeInteger(data.messageCount) ||
    data.messageCount < 0 ||
    typeof data.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.exportedAt))
  )
    throw new Error('INVALID_CONVERSATION_EXPORT');
  return data as ConversationExport;
}

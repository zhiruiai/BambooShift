// The built-in Discourse tools return identifiers. Build links from the connected site
// so a remote response cannot supply another host or change the installation subpath.
export function discoursePostUrl(
  endpoint: URL,
  tool: string,
  receipt: unknown,
): string | undefined {
  if (!['discourse_create_topic', 'discourse_create_post'].includes(tool)) return;
  if (!/\/mcp\/?$/.test(endpoint.pathname)) return;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return;
  const { id, topic_id: topicId, post_number: postNumber } = receipt as Record<string, unknown>;
  const positiveId = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (!positiveId(id) || !positiveId(topicId)) return;
  const topicUrl = endpoint.href.replace(/\/mcp\/?$/, `/t/${topicId}`);
  if (tool === 'discourse_create_topic') return topicUrl;
  return positiveId(postNumber) ? `${topicUrl}/${postNumber}` : undefined;
}

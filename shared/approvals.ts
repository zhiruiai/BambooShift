/** Server-owned human identity. Models and request bodies cannot select this actor. */
export interface ActionRequester {
  userId: string;
  name?: string;
  messageId?: string;
}
export interface ApprovalActor {
  userId?: string;
  isOwner: boolean;
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function parseActionRequester(value: unknown): ActionRequester | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !['userId', 'name', 'messageId'].includes(key)) ||
    !identifier(source.userId) ||
    (source.messageId !== undefined && !identifier(source.messageId)) ||
    (source.name !== undefined &&
      (typeof source.name !== 'string' ||
        !source.name.trim() ||
        source.name.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(source.name) ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(source.name)))
  )
    return;
  return {
    userId: source.userId,
    ...(source.name !== undefined ? { name: source.name as string } : {}),
    ...(source.messageId !== undefined ? { messageId: source.messageId as string } : {}),
  };
}
/** Names and input-message IDs never establish identity. */
export function sameActionRequester(a: unknown, b: unknown): boolean {
  const first = parseActionRequester(a),
    second = parseActionRequester(b);
  return !!first && !!second && first.userId === second.userId;
}
export function canDecideAction(requester: unknown, actor: ApprovalActor): boolean {
  if (requester === undefined) return actor.isOwner === true;
  const parsed = parseActionRequester(requester);
  return !!parsed && identifier(actor.userId) && parsed.userId === actor.userId;
}

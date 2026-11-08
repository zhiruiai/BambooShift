/** New working groups and newly confirmed team plans use the same limits. */
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 6;

/** Existing groups can retain one member. Oversized legacy groups may only
 * reorder or remove their original members until saved within the normal cap. */
export function canEditGroupMembers(current: readonly string[], next: readonly string[]): boolean {
  if (next.length < 1 || new Set(next).size !== next.length) return false;
  if (current.length > GROUP_MAX_MEMBERS) {
    const previous = new Set(current);
    return next.every((id) => previous.has(id));
  }
  return next.length <= GROUP_MAX_MEMBERS;
}

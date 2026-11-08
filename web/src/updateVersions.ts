export type UpdateComparison = 'current' | 'update_available' | 'unknownVersion';
function version(value: string) {
  if (value.length > 128) return;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return;
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return;
  const pre = match[4]?.split('.') || [];
  if (pre.some((item) => /^\d+$/.test(item) && item.length > 1 && item.startsWith('0'))) return;
  return { core, pre };
}
export function compareUpdate(
  current: string | undefined,
  latest: string | null,
): UpdateComparison {
  const a = current && version(current),
    b = latest && version(latest);
  if (!a || !b || b.pre.length) return 'unknownVersion';
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index])
      return a.core[index] < b.core[index] ? 'update_available' : 'current';
  }
  return a.pre.length ? 'update_available' : 'current';
}
export function validReleaseRepository(value: string) {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
    !value.split('/')[0].includes('--') &&
    !['.', '..'].includes(value.split('/')[1])
  );
}
export function releaseUrl(repository: string, tag: string) {
  return validReleaseRepository(repository) &&
    !['.', '..'].includes(tag) &&
    /^[A-Za-z0-9._+-]{1,128}$/.test(tag)
    ? `https://github.com/${repository}/releases/tag/${tag}`
    : undefined;
}

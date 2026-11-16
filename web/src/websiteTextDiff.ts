export const websiteDiffMaxBytes = 128 * 1024;
const maxLines = 2000;
const maxLineLength = 2000;
const maxCells = 1_000_000;
const maxRows = 400;

export type WebsiteDiffLine = {
  kind: 'same' | 'added' | 'removed';
  text: string;
  before?: number;
  after?: number;
};
export type WebsiteDiffRow = WebsiteDiffLine | { kind: 'gap'; count: number };
export type WebsiteTextDiff =
  | { kind: 'limited' }
  | {
      kind: 'ready';
      rows: WebsiteDiffRow[];
      added: number;
      removed: number;
      truncated: boolean;
      formatOnly: boolean;
    };

/** Bounded line comparison: no quadratic work for large or heavily rewritten files. */
export function websiteTextDiff(before: string, after: string): WebsiteTextDiff {
  if (before.length + after.length > websiteDiffMaxBytes * 2) return { kind: 'limited' };
  const lines = (text: string) => (text ? text.replace(/\r\n?/g, '\n').split('\n') : []);
  const old = lines(before),
    next = lines(after);
  if (
    old.length > maxLines ||
    next.length > maxLines ||
    [...old, ...next].some((line) => line.length > maxLineLength)
  )
    return { kind: 'limited' };
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let endOld = old.length,
    endNext = next.length;
  while (endOld > start && endNext > start && old[endOld - 1] === next[endNext - 1]) {
    endOld--;
    endNext--;
  }
  const height = endOld - start,
    width = endNext - start;
  if ((height + 1) * (width + 1) > maxCells) return { kind: 'limited' };
  const stride = width + 1;
  const lengths = new Uint16Array((height + 1) * stride);
  for (let i = height - 1; i >= 0; i--)
    for (let j = width - 1; j >= 0; j--)
      lengths[i * stride + j] =
        old[start + i] === next[start + j]
          ? lengths[(i + 1) * stride + j + 1] + 1
          : Math.max(lengths[(i + 1) * stride + j], lengths[i * stride + j + 1]);
  const all: WebsiteDiffLine[] = [];
  let i = 0,
    j = 0;
  const same = () => all.push({ kind: 'same', text: old[i], before: ++i, after: ++j });
  while (i < start) same();
  while (i < endOld || j < endNext) {
    if (i < endOld && j < endNext && old[i] === next[j]) same();
    else if (
      i < endOld &&
      (j === endNext ||
        lengths[(i - start + 1) * stride + j - start] >=
          lengths[(i - start) * stride + j - start + 1])
    )
      all.push({ kind: 'removed', text: old[i], before: ++i });
    else all.push({ kind: 'added', text: next[j], after: ++j });
  }
  while (i < old.length) same();
  let added = 0,
    removed = 0;
  const visible = new Set<number>();
  all.forEach((line, index) => {
    if (line.kind === 'same') return;
    if (line.kind === 'added') added++;
    else removed++;
    for (
      let cursor = Math.max(0, index - 3);
      cursor <= Math.min(all.length - 1, index + 3);
      cursor++
    )
      visible.add(cursor);
  });
  const rows: WebsiteDiffRow[] = [];
  let skipped = 0,
    shown = 0,
    truncated = false;
  for (let index = 0; index < all.length; index++) {
    if (!visible.has(index)) {
      skipped++;
      continue;
    }
    if (shown === maxRows) {
      truncated = true;
      break;
    }
    if (skipped) rows.push({ kind: 'gap', count: skipped });
    skipped = 0;
    rows.push(all[index]);
    shown++;
  }
  if (!truncated && skipped && rows.length) rows.push({ kind: 'gap', count: skipped });
  return {
    kind: 'ready',
    rows,
    added,
    removed,
    truncated,
    formatOnly: !added && !removed && before !== after,
  };
}

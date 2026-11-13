export const MAX_MCP_IMPORT_LENGTH = 65_536;
const MAX_SERVERS = 100;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type RemoteMcpCandidate = { name: string; url: string };
export type RemoteMcpPreview = {
  candidates: RemoteMcpCandidate[];
  skipped: number;
  error: 'empty' | null;
};
export type RemoteMcpImport =
  | { ok: true; candidates: RemoteMcpCandidate[]; skipped: number }
  | { ok: false; reason: 'json' | 'shape' | 'size' | 'count' | 'empty' };

function address(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    byteLength(value) > 2048 ||
    /[\s\\?#<>\p{Cc}\p{Cf}]|\$\{/u.test(value)
  )
    return;
  const authority = /^https:\/*([^/]+)(?:\/.*)?$/i.exec(value)?.[1];
  if (!authority || authority.includes('@')) return;
  // Keep raw spelling: the shared Rust preview owns public-host validation and WHATWG/IDNA.
  return value;
}

/** Project names and credential-free HTTPS strings only. Preview must validate before use. */
export function parseRemoteMcpImport(source: string): RemoteMcpImport {
  if (source.length > MAX_MCP_IMPORT_LENGTH) return { ok: false, reason: 'size' };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!object(value)) return { ok: false, reason: 'shape' };
  const groups = ['mcpServers', 'servers'].filter((key) => Object.hasOwn(value, key));
  if (!groups.length || groups.some((key) => !object(value[key])))
    return { ok: false, reason: 'shape' };
  const entries = groups.flatMap((key) => Object.entries(value[key] as Record<string, unknown>));
  if (entries.length > MAX_SERVERS) return { ok: false, reason: 'count' };
  const candidates: RemoteMcpCandidate[] = [];
  const seen = new Set<string>();
  for (const [key, entry] of entries) {
    const name = key.trim();
    if (
      !name ||
      name.length > 80 ||
      /[\p{Cc}\p{Cf}]/u.test(name) ||
      !object(entry) ||
      Object.hasOwn(entry, 'command') ||
      Object.hasOwn(entry, 'args') ||
      ['type', 'transport'].some(
        (field) =>
          Object.hasOwn(entry, field) &&
          (typeof entry[field] !== 'string' || !['http', 'streamable-http'].includes(entry[field])),
      )
    )
      continue;
    const url = address(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ name, url });
  }
  return candidates.length
    ? { ok: true, candidates, skipped: entries.length - candidates.length }
    : { ok: false, reason: 'empty' };
}

/** Validate the preview boundary without introducing a second URL normalization algorithm. */
export function readRemoteMcpPreview(value: unknown): RemoteMcpPreview {
  const invalid = () => {
    throw Error('Invalid import preview response.');
  };
  if (!object(value)) return invalid();
  const { candidates: entries, skipped, error } = value;
  if (
    !Array.isArray(entries) ||
    !Number.isInteger(skipped) ||
    typeof skipped !== 'number' ||
    skipped < 0 ||
    entries.length + skipped > 100 ||
    (error !== null && error !== 'empty') ||
    (error === 'empty') !== (entries.length === 0)
  )
    return invalid();
  const candidates: RemoteMcpCandidate[] = [],
    seen = new Set<string>();
  for (const entry of entries) {
    if (!object(entry) || typeof entry.name !== 'string' || typeof entry.url !== 'string')
      return invalid();
    const checked = parseRemoteMcpImport(
      JSON.stringify({ servers: { [entry.name]: { url: entry.url } } }),
    );
    if (
      !checked.ok ||
      checked.candidates.length !== 1 ||
      checked.candidates[0].name !== entry.name ||
      checked.candidates[0].url !== entry.url ||
      seen.has(entry.url)
    )
      return invalid();
    seen.add(entry.url);
    candidates.push(checked.candidates[0]);
  }
  return { candidates, skipped, error };
}

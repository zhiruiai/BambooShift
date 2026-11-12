import { validAppAddress } from './appConnections';

export const MAX_MCP_IMPORT_LENGTH = 65_536;
const MAX_SERVERS = 100;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type RemoteMcpCandidate = { name: string; url: string };
export type RemoteMcpImport =
  | { ok: true; candidates: RemoteMcpCandidate[]; skipped: number }
  | { ok: false; reason: 'json' | 'shape' | 'size' | 'count' | 'empty' };

function address(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    byteLength(value) > 2048 ||
    /[\s\\?#<>\p{Cc}\p{Cf}]|\$\{/u.test(value) ||
    !validAppAddress(value)
  )
    return;
  const url = new URL(value);
  const host = url.hostname.replace(/\.$/, '');
  // Local parsing never probes DNS. The server still verifies the actual destination on connect.
  if (
    !host.includes('.') ||
    /^[\d.]+$/.test(host) ||
    host.includes(':') ||
    /\.(?:localhost|local|internal|test|invalid|onion|lan|home|arpa)$/.test(host) ||
    host.split('.').some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ||
    byteLength(url.href) > 2048
  )
    return;
  return url.href;
}

/** Only names and public remote endpoints leave this parser; all credential fields are discarded. */
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

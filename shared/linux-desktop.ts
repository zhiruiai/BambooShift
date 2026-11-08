/** Public identity only. The privileged helper owns manifest/path/process validation. */
export interface DesktopSessionRef {
  id: string;
  generation: string;
}
export type LinuxDesktopSession = DesktopSessionRef;
export const VIRTUAL_DESKTOP_CAPABILITY = 'virtual-desktop-v1';
/** UTF-16 units, matching JavaScript string.length in UI and API validation. */
export const LINUX_DESKTOP_MAX_TEXT_UNITS = 300;
const sessionUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseDesktopSession(value: unknown): DesktopSessionRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (
    !Object.hasOwn(candidate, 'id') ||
    !Object.hasOwn(candidate, 'generation') ||
    typeof candidate.id !== 'string' ||
    typeof candidate.generation !== 'string' ||
    candidate.id.length !== 36 ||
    candidate.generation.length !== 36 ||
    !sessionUuid.test(candidate.id) ||
    !sessionUuid.test(candidate.generation)
  )
    return;
  return { id: candidate.id, generation: candidate.generation };
}
export function sameDesktopSession(a: unknown, b: unknown): boolean {
  const first = parseDesktopSession(a),
    second = parseDesktopSession(b);
  return !!first && !!second && first.id === second.id && first.generation === second.generation;
}

export interface LinuxDesktopFrame {
  displayId: number;
  geometryToken: string;
  width: number;
  height: number;
}

export type LinuxDesktopRequest =
  | { op: 'status' }
  | { op: 'capture'; enabled: true; session: LinuxDesktopSession }
  | {
      op: 'input';
      enabled: true;
      session: LinuxDesktopSession;
      frame: LinuxDesktopFrame;
      input: unknown;
    };

export type LinuxDesktopErrorCode =
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'STALE_FRAME'
  | 'STALE_SESSION'
  | 'INVALID_REQUEST'
  | 'DESKTOP_UNAVAILABLE'
  | 'INPUT_FAILED'
  | 'CAPTURE_FAILED'
  | 'CLEANUP_UNKNOWN';

export type LinuxDesktopReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: LinuxDesktopErrorCode; cleanupConfirmed: boolean } };

export const LINUX_DESKTOP_MAX_REQUEST_BYTES = 128 * 1024;
export const LINUX_DESKTOP_MAX_REPLY_BYTES = 12 * 1024 * 1024;
export const LINUX_DESKTOP_MAX_PNG_BYTES = 8 * 1024 * 1024;
export const LINUX_DESKTOP_TIMEOUT_MS = 15_000;

import type { DesktopSessionRef } from './linux-desktop.js';

export const SCREEN_LIFECYCLE_CAPABILITY = 'screen-lifecycle-v1';
export const SCREEN_REVISION_HEADER = 'X-OpenBot-Screen-Revision';
export type ScreenLifecycleKind = 'release' | 'reset';
export interface ScreenLifecycleRequest {
  operationId: string;
  kind: ScreenLifecycleKind;
  expectedRevision: string;
  expectedSession: DesktopSessionRef;
}
export interface ScreenLifecycleReceipt {
  version: 1;
  operationId: string;
  screenId: string;
  kind: ScreenLifecycleKind;
  status: 'pending' | 'complete' | 'blocked';
  phase: 'reserved' | 'browser_closed' | 'desktop_ready' | 'complete';
  previous: { revision: string; session: DesktopSessionRef };
  next: { revision: string; session: DesktopSessionRef };
  error?: string;
}
export interface ScreenLifecycleOptions {
  /** Fixed server-owned directory. Never supplied by HTTP callers. */
  stateDir: string;
  interpreterPath: string;
  /** The deployed desktop-session.py, invoked only with --lifecycle. */
  helperPath: string;
}

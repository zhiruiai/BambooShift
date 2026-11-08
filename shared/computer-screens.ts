import type { ComputerState } from './types.js';
import type { DesktopSessionRef } from './linux-desktop.js';
export const SCREEN_POOL_CAPABILITY = 'screen-pool-v1';
export const SCREEN_POOL_PROTOCOL = 'openbot-screen-pool-v1';
export const SCREEN_ID_HEADER = 'X-OpenBot-Screen-Id';
export const WORKSPACE_SCOPE_HEADER = 'X-OpenBot-Workspace-Scope';
export const MAX_COMPUTER_SCREENS = 2;
export interface ComputerScreenConfiguration {
  id: string;
  manifestPath: string;
  session: DesktopSessionRef;
}
export interface ComputerScreenPoolConfiguration {
  version: 1;
  workspaceScopeId: string;
  screens: ComputerScreenConfiguration[];
}
export interface ComputerScreenState {
  id: string;
  session: DesktopSessionRef;
  revision?: string;
  lifecycle?: { state: 'ready' | 'changing' | 'blocked'; operationId?: string };
  available: boolean;
  state?: ComputerState;
  reason?: string;
}
export interface ComputerScreenInventory {
  protocol: typeof SCREEN_POOL_PROTOCOL;
  instanceId: string;
  workspaceScopeId: string;
  capacity: { max: 2; configured: number; ready: number };
  screens: ComputerScreenState[];
}

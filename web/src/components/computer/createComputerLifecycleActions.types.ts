import type { ComputerState } from '../../../../shared/types';
import { type ComputerLifecycleIntent } from '../../computerLifecycle';
import { type BotScreenInventory } from '../../computerScope';
import { type FileComputerAction } from '../ComputerFiles';
export interface ComputerLifecycleActionsContext {
  observe: (key: string, work: () => Promise<void>) => Promise<void>;
  scope: {
    key: string;
    baseUrl: string | undefined;
    machineUrl: string;
    ticket: () => number;
    current: (value: number) => boolean;
    invalidate: () => void;
    response: (path: string, init?: RequestInit, machine?: boolean) => Promise<Response>;
    request: <T>(path: string, method?: string, body?: unknown, machine?: boolean) => Promise<T>;
    suspend(): void;
    resume(): void;
    guard<T>(work: () => Promise<T>, allowed?: () => boolean): () => Promise<T>;
    dispose(): void;
    endLease(leaseId: string): Promise<void>;
    startLease<T extends { leaseId: string }>(): Promise<T>;
  };
  setPermissionBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  agentId: string | undefined;
  current: (version: number) => boolean;
  setInventory: import('react').Dispatch<
    import('react').SetStateAction<BotScreenInventory | undefined>
  >;
  applyScreen: (state: ComputerState) => void;
  setControlError: import('react').Dispatch<import('react').SetStateAction<string>>;
  canManage: boolean;
  busy: boolean;
  inputBusy: boolean;
  preparing: boolean;
  lifecycleLocalBlock: string;
  lifecycleUnknown: boolean;
  setLifecycleConfirmation: import('react').Dispatch<
    import('react').SetStateAction<ComputerLifecycleIntent | null>
  >;
  computerRef: import('react').RefObject<ComputerState>;
  setLifecycleUnknown: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setLifecycleError: import('react').Dispatch<import('react').SetStateAction<string>>;
  setLifecycleNotice: import('react').Dispatch<import('react').SetStateAction<string>>;
  lifecycleConfirmationRef: import('react').RefObject<ComputerLifecycleIntent | null>;
  lifecyclePendingRef: import('react').RefObject<boolean>;
  lifecycleUnknownRef: import('react').RefObject<boolean>;
  observationRequests: import('react').RefObject<Map<string, Promise<void>>>;
  clearShot: () => void;
  lifecycleRecoveryRef: import('react').RefObject<ComputerLifecycleIntent | null>;
  controlTransition: import('react').RefObject<boolean>;
  setLifecyclePending: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setInputBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setActions: import('react').Dispatch<import('react').SetStateAction<FileComputerAction[]>>;
  refresh: () => Promise<void>;
  mounted: import('react').RefObject<boolean>;
  agent: import('../../../../shared/types').BotAgent | undefined;
  setPreparing: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  screenReady: boolean;
  endTakeover: () => Promise<void>;
  statusSequence: import('react').RefObject<number>;
  checkStatus: () => Promise<void>;
}

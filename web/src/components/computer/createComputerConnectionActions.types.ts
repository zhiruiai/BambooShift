import type { ComputerState } from '../../../../shared/types';
import { type FileComputerAction } from '../ComputerFiles';
import { type Lease, type TakeoverStatus } from './types';
export interface ComputerConnectionActionsContext {
  cloudPreparing: import('react').RefObject<boolean>;
  observationRequests: import('react').RefObject<Map<string, Promise<void>>>;
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
  current: (version: number) => boolean;
  onAction: (w: () => Promise<unknown>, s?: string) => Promise<void>;
  mounted: import('react').RefObject<boolean>;
  loadActions: () => Promise<void>;
  refresh: () => Promise<void>;
  panelRef: import('react').RefObject<'screen' | 'files'>;
  approvalState: import('react').RefObject<{
    actions: FileComputerAction[];
    owner: boolean;
    userId: string | undefined;
    busy: boolean;
    inputBusy: boolean;
    preparing: boolean;
    controlled: boolean;
    screenReady: boolean;
    panel: 'screen' | 'files';
  }>;
  deciding: import('react').RefObject<Set<string>>;
  screenshot: () => Promise<void>;
  connectionRunning: import('react').RefObject<boolean>;
  busy: boolean;
  inputBusy: boolean;
  setConnectionPending: import('react').Dispatch<
    import('react').SetStateAction<'connect' | 'disconnect' | 'reconnect' | null>
  >;
  setConnectionError: import('react').Dispatch<import('react').SetStateAction<string>>;
  setInputBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  leaseRef: import('react').RefObject<Lease | null>;
  endTakeover: () => Promise<void>;
  updateLease: (value: Lease | null) => void;
  setTakeover: (status: TakeoverStatus | null) => void;
  setInputText: import('react').Dispatch<import('react').SetStateAction<string>>;
  controlTransition: import('react').RefObject<boolean>;
  statusSequence: import('react').RefObject<number>;
  clearShot: () => void;
  setMachine: import('react').Dispatch<import('react').SetStateAction<ComputerState>>;
  setToken: import('react').Dispatch<import('react').SetStateAction<string>>;
  checkStatus: () => Promise<void>;
  checkComputer: () => Promise<void>;
}

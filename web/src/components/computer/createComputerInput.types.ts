import { type Lease, type TakeoverStatus } from './types';
export interface ComputerInputContext {
  screenReady: boolean;
  takeoverSupported: boolean;
  usableLease: (lease?: Lease | null) => boolean;
  pausePrivateFrames: () => void;
  inputBusy: boolean;
  teachingBlocked?: boolean;
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
  controlTransition: import('react').RefObject<boolean>;
  statusSequence: import('react').RefObject<number>;
  setInputBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setControlError: import('react').Dispatch<import('react').SetStateAction<string>>;
  current: (version: number) => boolean;
  updateLease: (value: Lease | null) => void;
  setTakeover: (status: TakeoverStatus | null) => void;
  setClock: import('react').Dispatch<import('react').SetStateAction<number>>;
  setAutoRefresh: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  clearShot: () => void;
  screenshot: () => Promise<void>;
  leaseRef: import('react').RefObject<Lease | null>;
  setInputText: import('react').Dispatch<import('react').SetStateAction<string>>;
  setDragStart: import('react').Dispatch<
    import('react').SetStateAction<{ x: number; y: number } | null>
  >;
  busy: boolean;
  preparing: boolean;
  connectionRunning: import('react').RefObject<boolean>;
  observationRequests: import('react').RefObject<Map<string, Promise<void>>>;
  onSelectBot: (id: string) => void;
  onClose: () => void;
  checkStatus: () => Promise<void>;
  shotError: string;
  shotAt: string;
  loading: boolean;
  isDesktop: boolean;
  pointerMode: 'click' | 'double' | 'right' | 'drag';
  dragStart: { x: number; y: number } | null;
}

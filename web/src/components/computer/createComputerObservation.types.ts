import type { ComputerState } from '../../../../shared/types';
import type { createComputerFrameMedia } from '../../computerFrameMedia';
import type { createComputerScope } from '../../computerScope';
import { type ComputerLifecycleIntent } from '../../computerLifecycle';
import { type FileComputerAction } from '../ComputerFiles';
import { type Lease, type TakeoverStatus } from './types';
export interface ComputerObservationContext {
  mounted: import('react').RefObject<boolean>;
  scope: ReturnType<typeof createComputerScope>;
  agentId: string | undefined;
  computerRef: import('react').RefObject<ComputerState>;
  leaseRef: import('react').RefObject<Lease | null>;
  observationRequests: import('react').RefObject<Map<string, Promise<void>>>;
  media: ReturnType<typeof createComputerFrameMedia>;
  privateFramesPaused: import('react').RefObject<boolean>;
  takeoverRef: import('react').RefObject<TakeoverStatus | null>;
  setTakeoverState: import('react').Dispatch<import('react').SetStateAction<TakeoverStatus | null>>;
  setInputText: import('react').Dispatch<import('react').SetStateAction<string>>;
  setInputBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setPermissionBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setPreparing: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  lifecycleRecoveryRef: import('react').RefObject<ComputerLifecycleIntent | null>;
  lifecyclePendingRef: import('react').RefObject<boolean>;
  setLifecycleUnknown: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setLifecycleError: import('react').Dispatch<import('react').SetStateAction<string>>;
  setLifecycleConfirmation: import('react').Dispatch<
    import('react').SetStateAction<ComputerLifecycleIntent | null>
  >;
  setLifecycleNotice: import('react').Dispatch<import('react').SetStateAction<string>>;
  setComputer: import('react').Dispatch<import('react').SetStateAction<ComputerState>>;
  setLease: import('react').Dispatch<import('react').SetStateAction<Lease | null>>;
  setShotError: import('react').Dispatch<import('react').SetStateAction<string>>;
  setLoading: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setZoomed: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setDragStart: import('react').Dispatch<
    import('react').SetStateAction<{ x: number; y: number } | null>
  >;
  setPointerMode: import('react').Dispatch<
    import('react').SetStateAction<'click' | 'double' | 'right' | 'drag'>
  >;
  cloudPreparing: import('react').RefObject<boolean>;
  panelRef: import('react').RefObject<'screen' | 'files'>;
  setActions: import('react').Dispatch<import('react').SetStateAction<FileComputerAction[]>>;
  setControlError: import('react').Dispatch<import('react').SetStateAction<string>>;
  controlTransition: import('react').RefObject<boolean>;
  statusSequence: import('react').RefObject<number>;
}

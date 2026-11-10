import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { isSharedBot } from '../../../../shared/shared-bots';
import type { CloudComputerState } from '../../../../shared/cloud-computer';
import type { ComputerState } from '../../../../shared/types';
import { useAccount } from '../../AccountContext';
import { type ComputerLifecycleIntent } from '../../computerLifecycle';
import {
  createComputerScope,
  screenIdentity,
  unpreparedScreen,
  type BotScreenInventory,
} from '../../computerScope';
import {
  createComputerFrameMedia,
  PRIVATE_FRAME_CAPABILITY,
  type ScreenFrame,
} from '../../computerFrameMedia';
import { currentWorkspaceId } from '../../workspace-scope';
import { createComputerConnectionActions } from './createComputerConnectionActions';
import type { ComputerConnectionActionsContext } from './createComputerConnectionActions.types';
import { createComputerInput } from './createComputerInput';
import type { ComputerInputContext } from './createComputerInput.types';
import { createComputerLifecycleActions } from './createComputerLifecycleActions';
import type { ComputerLifecycleActionsContext } from './createComputerLifecycleActions.types';
import { createComputerObservation, useComputerFramePolling } from './createComputerObservation';
import type { ComputerObservationContext } from './createComputerObservation.types';
import {
  type ComputerAction,
  type ComputerDialogProps,
  type Lease,
  type TakeoverStatus,
} from './types';
export function useComputerDialog({
  data,
  agentId,
  onSelectBot,
  conversationId,
  conversationTitle,
  initialPanel = 'screen',
  busy: externalBusy,
  onClose,
  onAction,
  refresh,
}: ComputerDialogProps) {
  const readActionContext = (): ComputerObservationContext &
    ComputerInputContext &
    ComputerLifecycleActionsContext &
    ComputerConnectionActionsContext => actionContext;

  const account = useAccount();
  const canManage = !account || account.workspace.role === 'owner';
  const identity = useRef({
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: account?.session.user?.id,
    agentId,
  });
  identity.current = {
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: account?.session.user?.id,
    agentId,
  };
  const [scope] = useState(() =>
    createComputerScope({
      workspaceId: account?.workspace.id || currentWorkspaceId(),
      userId: account?.session.user?.id,
      agentId,
      identity: () => identity.current,
    }),
  );
  const [machine, setMachine] = useState(data.computer);
  const [inventory, setInventory] = useState<BotScreenInventory>();
  const agent = data.agents?.find((a) => a.id === agentId);
  const directChats = (data.conversations || []).filter(
    (chat) => !chat.isGroup && chat.agentIds.length === 1 && chat.agentIds[0] === agentId,
  );
  const teachingEligible =
    canManage &&
    !!account?.session.user?.id &&
    !!agent &&
    !isSharedBot(agent) &&
    directChats.length === 1 &&
    directChats[0].id === conversationId;
  const teachingBlockRef = useRef(teachingEligible);
  const [teachingBlocked, setTeachingBlocked] = useState(teachingEligible);
  const [updateTeachingBlocked] = useState(() => (blocked: boolean) => {
    teachingBlockRef.current = blocked;
    setTeachingBlocked(blocked);
  });
  const [preparing, setPreparing] = useState(false);
  const [lifecycleConfirmation, setLifecycleConfirmation] =
    useState<ComputerLifecycleIntent | null>(null);
  const [lifecyclePending, setLifecyclePending] = useState(false),
    [lifecycleUnknown, setLifecycleUnknown] = useState(false),
    [lifecycleError, setLifecycleError] = useState(''),
    [lifecycleNotice, setLifecycleNotice] = useState('');
  const lifecyclePendingRef = useRef(false),
    lifecycleConfirmationRef = useRef(lifecycleConfirmation),
    lifecycleUnknownRef = useRef(lifecycleUnknown),
    lifecycleRecoveryRef = useRef<ComputerLifecycleIntent | null>(null);
  lifecycleConfirmationRef.current = lifecycleConfirmation;
  lifecycleUnknownRef.current = lifecycleUnknown;
  const busy = externalBusy || lifecyclePending;

  const [cloudState, setCloudState] = useState<CloudComputerState | null>(null);
  const [panel, setPanelState] = useState<'screen' | 'files'>(initialPanel);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [computer, setComputer] = useState<ComputerState>(() =>
      unpreparedScreen(data.computer, agentId),
    ),
    [permissionBusy, setPermissionBusy] = useState(false);
  const [pointerMode, setPointerMode] = useState<'click' | 'double' | 'right' | 'drag'>('click'),
    [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const computerRef = useRef(computer);
  const screenReady =
    !lifecyclePending &&
    !lifecycleUnknown &&
    computer.botScreen?.status === 'ready' &&
    (!computer.botScreen.shared || !!computer.targetRevision) &&
    computer.connected &&
    !computer.botScreen.lifecycle?.operation &&
    computer.botScreen.lifecycle?.state !== 'changing' &&
    computer.botScreen.lifecycle?.state !== 'blocked';
  const currentScreenIdentity = screenIdentity(computer);
  const takeoverSupported =
    !!identity.current.userId && !!computer.capabilities?.includes(PRIVATE_FRAME_CAPABILITY);
  const isDesktop = computer.surface === 'desktop';
  const virtualDesktop = computer.desktop?.kind === 'virtual';
  const desktopLabel = virtualDesktop
    ? uiText('computer:text_c255841f6809')
    : uiText('computer:text_5b096afbdb0c');
  const desktopScreenLabel = virtualDesktop
    ? uiText('computer:text_33491e07b151')
    : uiText('computer:text_1245e0dc8cd5');
  const [actions, setActions] = useState<ComputerAction[]>([]),
    [url, setUrl] = useState('https://example.com'),
    [remote, setRemote] = useState(data.computer.savedRemote?.url || ''),
    [token, setToken] = useState('');
  const [connectionPending, setConnectionPending] = useState<
    'connect' | 'disconnect' | 'reconnect' | null
  >(null);
  const [connectionError, setConnectionError] = useState('');
  const connectionRunning = useRef(false),
    remoteEdited = useRef(false);
  const [frame, setFrame] = useState<ScreenFrame | null>(null),
    [shotError, setShotError] = useState(''),
    [loading, setLoading] = useState(false),
    [controlError, setControlError] = useState('');
  const [media] = useState(() => createComputerFrameMedia(setFrame));
  const [lease, setLease] = useState<Lease | null>(null),
    [takeover, setTakeoverState] = useState<TakeoverStatus | null>(null),
    [inputBusy, setInputBusy] = useState(false),
    [inputText, setInputText] = useState(''),
    [clock, setClock] = useState(Date.now()),
    [autoRefresh, setAutoRefresh] = useState(true),
    [zoomed, setZoomed] = useState(false),
    [shotSize, setShotSize] = useState({ width: 1440, height: 900 });
  const leaseRef = useRef<Lease | null>(null),
    takeoverRef = useRef<TakeoverStatus | null>(null),
    privateFramesPaused = useRef(true),
    mounted = useRef(true),
    statusSequence = useRef(0),
    controlTransition = useRef(false),
    cloudPreparing = useRef(false),
    observationRequests = useRef(new Map<string, Promise<void>>());
  const controlled = !!lease,
    otherControlled = !!takeover?.active && !lease;
  const visibleFrame =
    scope.current(scope.ticket()) &&
    screenReady &&
    panel === 'screen' &&
    (frame?.access === 'takeover'
      ? lease && !privateFramesPaused.current && Date.parse(lease.expiresAt) > Date.now()
      : !lease && !takeover?.active && !controlTransition.current)
      ? frame
      : null;
  const shot = visibleFrame?.url || '';
  const shotAt = visibleFrame?.capturedAt || '';
  const approvalState = useRef({
    actions,
    owner: canManage,
    userId: identity.current.userId,
    busy,
    inputBusy,
    preparing,
    controlled: controlled || otherControlled,
    screenReady,
    panel,
  });
  approvalState.current = {
    actions,
    owner: canManage,
    userId: identity.current.userId,
    busy: busy || (teachingEligible && teachingBlocked),
    inputBusy,
    preparing,
    controlled: controlled || otherControlled,
    screenReady,
    panel,
  };
  const deciding = useRef(new Set<string>());
  const remaining = lease
    ? Math.max(0, Math.ceil((new Date(lease.expiresAt).getTime() - clock) / 1000))
    : 0;
  const {
    current,
    applyScreen,
    updateLease,
    setTakeover,
    usableLease,
    expireLease,
    forgetLease,
    pausePrivateFrames,
    clearShot,
    observe,
    loadActions,
    checkStatus,
    screenshot,
  } = createComputerObservation(readActionContext);

  const { prepareCloudStart, run, decideAction, connection } =
    createComputerConnectionActions(readActionContext);

  useEffect(() => {
    scope.resume();
    mounted.current = true;
    void checkComputer();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadActions();
      void checkStatus();
      void checkComputer();
      if (leaseRef.current) setClock(Date.now());
    }, 3000);
    const visibility = () => {
      if (!document.hidden) void screenshot();
      else if (leaseRef.current) clearShot();
    };
    const forget = () => {
      scope.invalidate();
      observationRequests.current.clear();
      forgetLease();
      setInputBusy(false);
    };
    const events = [
      'pagehide',
      'openbot:account-expired',
      'openbot:unpaired',
      'openbot:revalidate',
    ];
    if (typeof window !== 'undefined')
      events.forEach((event) => window.addEventListener(event, forget));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      scope.suspend();
      observationRequests.current.clear();
      media.clear(false);
      if (typeof window !== 'undefined')
        events.forEach((event) => window.removeEventListener(event, forget));
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', visibility);
      const currentLease = leaseRef.current;
      leaseRef.current = null;
      if (currentLease) void scope.endLease(currentLease.leaseId).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (scope.current(scope.ticket())) return;
    scope.invalidate();
    forgetLease();
  }, [identity.current.userId, identity.current.workspaceId, agentId]);
  useEffect(() => {
    setActions([]);
    void loadActions();
  }, [panel]);
  useEffect(() => {
    if (!lease) return;
    const timer = setTimeout(
      () => expireLease(lease),
      Math.max(0, Date.parse(lease.expiresAt) - Date.now()) || 0,
    );
    return () => clearTimeout(timer);
  }, [lease?.leaseId, lease?.expiresAt]);
  useEffect(() => {
    setMachine(data.computer);
    void checkComputer();
  }, [data.computer]);
  useEffect(() => {
    if (!remoteEdited.current) setRemote(machine.savedRemote?.url || '');
  }, [machine.savedRemote?.url]);
  useEffect(() => {
    if (!screenReady) return;
    void checkStatus();
    void loadActions();
  }, [screenReady]);
  const observingWork = useComputerFramePolling(
    screenReady && panel === 'screen',
    currentScreenIdentity,
    lease?.leaseId,
    otherControlled,
    autoRefresh && !dragStart && !inputBusy,
    computer.botScreen,
    actions,
    screenshot,
  );
  const { startTakeover, endTakeover, finish, manual, clickScreen } =
    createComputerInput(readActionContext);
  const setPanel = (next: 'screen' | 'files') => {
    if (panelRef.current === next) return;
    panelRef.current = next;
    clearShot();
    setPanelState(next);
  };

  const { checkComputer, chooseLifecycle, submitLifecycle, prepareScreen, selectSurface } =
    createComputerLifecycleActions(readActionContext);
  const lifecycleLocalBlock =
    controlled || otherControlled
      ? uiText('computer:text_231bcfee98d9')
      : actions.some((action) => action.status === 'pending' || action.status === 'running')
        ? uiText('computer:text_ea3a545f2e5f')
        : '';

  const visibleActions = actions.filter(
    (action) =>
      panel === 'screen' || action.type === 'upload_file' || action.type === 'download_file',
  );

  const actionContext = {
    get teachingBlocked() {
      return teachingEligible && teachingBlockRef.current;
    },
    mounted,
    scope,
    agentId,
    computerRef,
    leaseRef,
    observationRequests,
    media,
    takeoverRef,
    privateFramesPaused,
    setTakeoverState,
    setTakeover,
    setInputText,
    setInputBusy,
    setPermissionBusy,
    setPreparing,
    lifecycleRecoveryRef,
    lifecyclePendingRef,
    setLifecycleUnknown,
    setLifecycleError,
    setLifecycleConfirmation,
    setLifecycleNotice,
    setComputer,
    setLease,
    setShotError,
    setLoading,
    setZoomed,
    setDragStart,
    setPointerMode,
    cloudPreparing,
    panelRef,
    setActions,
    setControlError,
    controlTransition,
    statusSequence,
    screenReady,
    takeoverSupported,
    usableLease,
    pausePrivateFrames,
    inputBusy,
    current,
    updateLease,
    setClock,
    setAutoRefresh,
    clearShot,
    screenshot,
    busy,
    preparing,
    connectionRunning,
    onSelectBot,
    onClose,
    checkStatus,
    shotError,
    shotAt,
    loading,
    isDesktop,
    pointerMode,
    dragStart,
    observe,
    setInventory,
    applyScreen,
    canManage,
    lifecycleLocalBlock,
    lifecycleUnknown,
    lifecycleConfirmationRef,
    lifecycleUnknownRef,
    setLifecyclePending,
    refresh,
    agent,
    endTakeover,
    onAction,
    loadActions,
    approvalState,
    deciding,
    setConnectionPending,
    setConnectionError,
    setMachine,
    setToken,
    checkComputer,
  };
  return {
    ...actionContext,
    teachingEligible,
    updateTeachingBlocked,
    teachingBlocked: teachingEligible && teachingBlocked,
    teachingBinding:
      lease && remaining > 0 && screenReady
        ? JSON.stringify([
            lease.leaseId,
            computer.botScreen?.screenId,
            computer.botScreen?.assignmentRevision,
            computer.surface,
            computer.desktop?.session?.id,
            computer.desktop?.session?.generation,
            agent?.configRevision,
          ])
        : undefined,
    desktopScreenLabel,
    finish,
    machine,
    account,
    cloudState,
    connectionPending,
    connection,
    connectionError,
    controlled,
    otherControlled,
    prepareCloudStart,
    setCloudState,
    data,
    inventory,
    panel,
    computer,
    permissionBusy,
    prepareScreen,
    externalBusy,
    lifecyclePending,
    lifecycleConfirmation,
    lifecycleError,
    lifecycleNotice,
    chooseLifecycle,
    submitLifecycle,
    setPanel,
    conversationId,
    conversationTitle,
    selectSurface,
    desktopLabel,
    remaining,
    virtualDesktop,
    startTakeover,
    zoomed,
    shot,
    bindScreenImage: media.bindImage,
    clickScreen,
    setShotSize,
    shotSize,
    controlError,
    autoRefresh,
    observingWork,
    manual,
    url,
    run,
    setUrl,
    inputText,
    visibleActions,
    identity,
    decideAction,
    remote,
    token,
    remoteEdited,
    setRemote,
  };
}

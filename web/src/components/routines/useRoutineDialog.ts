import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { RoutineOperationReceipt } from '../../../../shared/routine-operations';
import type { RoutineTransferReceipt } from '../../../../shared/routine-transfers';
import { isSharedBot } from '../../../../shared/shared-bots';
import { routineConfigSnapshot } from '../../../../shared/routine-operations';
import type { RoutineRun } from '../../../../shared/routine-runs';
import { DEFAULT_TIME_ZONE } from '../../../../shared/time-zone';
import type { BotAgent, Conversation, Routine } from '../../../../shared/types';
import { routineChatDestination, type RoutineChatRequest } from '../../routineChat';
import { draftForRoutine as draftFor, type RoutineDraft } from '../../routineDraft';
import { useRoutineOperations } from '../../routineOperations';
import { routineWebhookEndpoint } from '../../routineWebhooks';
import '../RoutineDialog.css';

function isDirectLocalRoutineTarget(agent?: BotAgent, chat?: Conversation) {
  return (
    !!agent &&
    !isSharedBot(agent) &&
    !!chat &&
    !chat.demo &&
    !chat.isGroup &&
    chat.agentIds.length === 1 &&
    chat.agentIds[0] === agent.id
  );
}

export function useRoutineDialog({
  agents,
  allAgents,
  conversations,
  routines,
  busy,
  conversationId,
  initialRoutineId,
  initialAction = 'view',
  onInitialActionConsumed,
  defaultTimeZone = DEFAULT_TIME_ZONE,
  workspaceId,
  userId,
  onChanged,
  canTransferRoutines = false,
  canManagePublicSearch = false,
  canManageWebhooks = false,
  onOpenConversation,
  onOpenRun,
  onChatRequest,
  onClose,
  onSave,
  onToggle,
  onDelete,
}: {
  agents: BotAgent[];
  allAgents: BotAgent[];
  conversations: Conversation[];
  routines: Routine[];
  busy: boolean;
  conversationId: string;
  initialRoutineId?: string | null;
  initialAction?: 'view' | 'edit' | 'delete';
  onInitialActionConsumed?: () => void;
  defaultTimeZone?: string;
  workspaceId?: string;
  userId?: string;
  onChanged?: (receipt: RoutineOperationReceipt | RoutineTransferReceipt) => void | Promise<void>;
  canTransferRoutines?: boolean;
  canManagePublicSearch?: boolean;
  canManageWebhooks?: boolean;
  onOpenConversation?: (receipt: RoutineOperationReceipt) => void | Promise<void>;
  onOpenRun?: (run: RoutineRun) => void | Promise<void>;
  onChatRequest?: (request: RoutineChatRequest) => Promise<void>;
  onClose: () => void;
  onSave: (body: unknown, id?: string) => Promise<void>;
  onToggle: (routine: Routine) => Promise<void>;
  onRun?: (routine: Routine) => Promise<void>;
  onDelete: (routine: Routine) => Promise<void>;
}) {
  const operations = useRoutineOperations({ workspaceId, userId, onChanged });
  const [transferring, setTransferring] = useState<Routine>();
  const initial = routines.find((routine) => routine.id === initialRoutineId);
  const [selectedId, setSelectedId] = useState<string | undefined>(initial?.id);
  const [editing, setEditing] = useState<Routine | undefined>(undefined);
  const [draft, setDraft] = useState(() => draftFor(agents, undefined, defaultTimeZone));
  const [deleting, setDeleting] = useState<Routine>(),
    [deleteError, setDeleteError] = useState('');
  const deleteLatest = useRef({ onDelete, busy, routines });
  deleteLatest.current = { onDelete, busy, routines };
  const draftRef = useRef(draft),
    baseline = useRef(JSON.stringify(draft)),
    mounted = useRef(true);
  draftRef.current = draft;
  const latest = useRef({ agents, defaultTimeZone });
  latest.current = { agents, defaultTimeZone };
  const chatLatest = useRef({ allAgents, conversations, routines, busy, onChatRequest });
  chatLatest.current = { allAgents, conversations, routines, busy, onChatRequest };
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const createDraft = useRef<RoutineDraft | undefined>(undefined);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false),
    openingRef = useRef(false);
  const savingRef = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [clock, setClock] = useState(Date.now());
  const targetConversation = conversations.find(
    (conversation) => conversation.id === (editing?.conversationId || conversationId),
  );
  const availableAgents = editing
    ? allAgents.filter((agent) => targetConversation?.agentIds.includes(agent.id))
    : agents;
  const operationBusy = operations.state.busy;
  const createLocked = !editing && (!!operations.state.request || !!operations.state.blocked);
  const disabled = busy || saving || opening || operationBusy;
  const formDisabled = disabled || createLocked;
  const chatDisabled =
    disabled ||
    !!operations.state.blocked ||
    (!!operations.state.request && !operations.state.receipt);
  const currentEditing = routines.find((routine) => routine.id === editing?.id);
  const editingMissing = !!editing && !currentEditing;
  const selected = routines.find((routine) => routine.id === selectedId);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const initialIntentConsumed = useRef(false);
  useEffect(() => {
    if (initialIntentConsumed.current) return;
    initialIntentConsumed.current = true;
    if (initial) {
      if (initialAction === 'edit') edit(initial);
      else if (initialAction === 'delete') askDelete(initial);
    }
    onInitialActionConsumed?.();
  }, []);
  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editing?.id]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (error) feedbackRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (
      operations.state.receipt?.kind === 'create' &&
      operations.state.receipt.status === 'created' &&
      createDraft.current &&
      draftRef.current === createDraft.current &&
      !editing
    ) {
      if (createDraft.current.mode === 'webhook') setSelectedId(operations.state.receipt.routineId);
      createDraft.current = undefined;
      resetEditor();
    }
  }, [operations.state.receipt]);

  function resetEditor() {
    setEditing(undefined);
    replaceDraft(draftFor(latest.current.agents, undefined, latest.current.defaultTimeZone));
    setError('');
  }
  function replaceDraft(value: RoutineDraft) {
    draftRef.current = value;
    baseline.current = JSON.stringify(value);
    setDraft(value);
  }
  function navigate(work: () => void) {
    if (
      !mounted.current ||
      !operations.scope.current(operations.scope.ticket()) ||
      savingRef.current ||
      openingRef.current ||
      busy ||
      operations.getState().busy
    )
      return;
    if (
      JSON.stringify(draftRef.current) !== baseline.current ||
      (operations.getState().request && !operations.getState().receipt)
    )
      setLeave(() => work);
    else work();
  }
  async function openResult(receipt: RoutineOperationReceipt) {
    if (
      !onOpenConversation ||
      !mounted.current ||
      openingRef.current ||
      receipt.status === 'missing'
    )
      return;
    const ticket = operations.scope.ticket();
    if (!operations.scope.current(ticket)) return;
    openingRef.current = true;
    setOpening(true);
    setError('');
    try {
      await onOpenConversation(receipt);
    } catch (cause) {
      if (mounted.current && operations.scope.current(ticket)) setError((cause as Error).message);
    } finally {
      openingRef.current = false;
      if (mounted.current && operations.scope.current(ticket)) setOpening(false);
    }
  }
  async function openRun(run: RoutineRun) {
    if (
      !onOpenRun ||
      !mounted.current ||
      openingRef.current ||
      !operations.scope.current(operations.scope.ticket())
    )
      return;
    const ticket = operations.scope.ticket();
    openingRef.current = true;
    setOpening(true);
    setError('');
    try {
      await onOpenRun(run);
    } catch (cause) {
      if (mounted.current && operations.scope.current(ticket)) setError((cause as Error).message);
    } finally {
      openingRef.current = false;
      if (mounted.current && operations.scope.current(ticket)) setOpening(false);
    }
  }
  function askDelete(routine: Routine) {
    if (chatDisabled) return;
    navigate(() => {
      setDeleting(structuredClone(routine));
      setDeleteError('');
    });
  }
  async function confirmDelete() {
    const ticket = operations.scope.ticket();
    if (
      !deleting ||
      !mounted.current ||
      !operations.scope.current(ticket) ||
      savingRef.current ||
      openingRef.current ||
      deleteLatest.current.busy ||
      operations.getState().busy
    )
      return;
    const current = deleteLatest.current.routines.find((routine) => routine.id === deleting.id);
    if (
      !current ||
      JSON.stringify(routineConfigSnapshot(current)) !==
        JSON.stringify(routineConfigSnapshot(deleting))
    ) {
      setDeleteError(uiText('routines:text_a2fafdcdc947'));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setDeleteError('');
    try {
      await deleteLatest.current.onDelete(deleting);
      if (!mounted.current || !operations.scope.current(ticket)) return;
      setDeleting(undefined);
      if (selectedId === deleting.id) setSelectedId(undefined);
      if (editing?.id === deleting.id) resetEditor();
    } catch (cause) {
      if (mounted.current && operations.scope.current(ticket))
        setDeleteError((cause as Error).message || uiText('routines:text_4e82ac7f7f5c'));
    } finally {
      savingRef.current = false;
      if (mounted.current && operations.scope.current(ticket)) setSaving(false);
    }
  }
  function chatRequestAllowed() {
    const state = operations.getState();
    return (
      mounted.current &&
      operations.scope.current(operations.scope.ticket()) &&
      !!chatLatest.current.onChatRequest &&
      !chatLatest.current.busy &&
      !savingRef.current &&
      !openingRef.current &&
      !state.busy &&
      !state.blocked &&
      !(state.request && !state.receipt)
    );
  }
  function requestChat(request: RoutineChatRequest) {
    if (!chatRequestAllowed()) return;
    navigate(() => void prepareChat(request));
  }
  async function prepareChat(request: RoutineChatRequest) {
    if (!chatRequestAllowed()) return;
    const ticket = operations.scope.ticket(),
      current = chatLatest.current;
    openingRef.current = true;
    setOpening(true);
    setError('');
    try {
      routineChatDestination(
        {
          agents: current.allAgents,
          conversations: current.conversations,
          routines: current.routines,
        },
        request,
      );
      await current.onChatRequest!(request);
    } catch (cause) {
      if (mounted.current && operations.scope.current(ticket)) setError((cause as Error).message);
    } finally {
      openingRef.current = false;
      if (mounted.current && operations.scope.current(ticket)) setOpening(false);
    }
  }
  function edit(routine: Routine) {
    navigate(() => {
      setSelectedId(routine.id);
      setEditing(routine);
      replaceDraft(draftFor(agents, routine));
      setError('');
    });
  }
  function canTransfer(routine: Routine) {
    const agent = allAgents.find((item) => item.id === routine.agentId);
    const chat = conversations.find((item) => item.id === routine.conversationId);
    return (
      canTransferRoutines &&
      !!agent &&
      !isSharedBot(agent) &&
      !!chat &&
      !chat.isGroup &&
      chat.agentIds.length === 1 &&
      chat.agentIds[0] === agent.id
    );
  }
  function canEditPublicSearch(agentId: string) {
    const agent = availableAgents.find((item) => item.id === agentId);
    return canManagePublicSearch && isDirectLocalRoutineTarget(agent, targetConversation);
  }
  function canEditWebhook(agentId: string) {
    const agent = availableAgents.find((item) => item.id === agentId);
    return (
      !!workspaceId &&
      !!userId &&
      canManageWebhooks &&
      isDirectLocalRoutineTarget(agent, targetConversation)
    );
  }
  function canConfigureWebhook(routine: Routine) {
    const agent = allAgents.find((item) => item.id === routine.agentId);
    const chat = conversations.find((item) => item.id === routine.conversationId);
    return (
      !!routineWebhookEndpoint(workspaceId, routine.id) &&
      !!userId &&
      canManageWebhooks &&
      isDirectLocalRoutineTarget(agent, chat)
    );
  }
  function askTransfer(routine: Routine) {
    if (chatDisabled || !canTransfer(routine)) return;
    navigate(() => setTransferring(structuredClone(routine)));
  }
  function change<K extends keyof RoutineDraft>(field: K, value: RoutineDraft[K]) {
    if (
      !mounted.current ||
      !operations.scope.current(operations.scope.ticket()) ||
      openingRef.current ||
      savingRef.current ||
      busy ||
      operations.getState().busy ||
      (!editing && (operations.getState().request || operations.getState().blocked))
    )
      return;
    const next = { ...draftRef.current, [field]: value };
    draftRef.current = next;
    setDraft(next);
    setError('');
  }

  return {
    transferring,
    setTransferring,
    canTransfer,
    canManagePublicSearch,
    canEditPublicSearch,
    canEditWebhook,
    canConfigureWebhook,
    askTransfer,
    onChanged,
    navigate,
    onClose,
    routines,
    editing,
    disabled,
    selectedId,
    mounted,
    operations,
    setSelectedId,
    allAgents,
    clock,
    onChatRequest,
    chatDisabled,
    requestChat,
    edit,
    onToggle,
    savingRef,
    busy,
    askDelete,
    selected,
    conversations,
    userId,
    workspaceId,
    deleting,
    onOpenRun,
    openRun,
    deleteError,
    setDeleting,
    setDeleteError,
    confirmDelete,
    saving,
    onOpenConversation,
    openResult,
    formDisabled,
    editingMissing,
    setError,
    targetConversation,
    availableAgents,
    draft,
    draftRef,
    conversationId,
    createDraft,
    setSaving,
    onSave,
    resetEditor,
    change,
    currentEditing,
    titleRef,
    error,
    feedbackRef,
    leave,
    setLeave,
    openingRef,
  };
}

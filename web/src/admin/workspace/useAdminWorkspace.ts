import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { AdminOverview } from '../../../../shared/admin';
import type { Bootstrap, Routine } from '../../../../shared/types';
import { useAccount } from '../../AccountContext';
import { createAppConnectionScope } from '../../appConnections';
import { canStopConversation } from '../../approvalUi';
import { currentWorkspaceId, workspaceApiUrl } from '../../workspace-scope';
import '../Admin.css';
import {
  AccessPanel,
  AutomationsPanel,
  BotsPanel,
  ComputerPanel,
  ModelsPanel,
  OverviewPanel,
  RecordsPanel,
  type AdminPanelProps,
  type AdminView,
} from '../AdminPanels';
import { AdminModal, initialView, sections } from './parts';
export function useAdminWorkspace() {
  const account = useAccount();
  const identity = useRef({
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: account?.session.user?.id,
  });
  identity.current = {
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: account?.session.user?.id,
  };
  const [scope] = useState(() =>
    createAppConnectionScope({ ...identity.current, identity: () => identity.current }),
  );
  const [view, setView] = useState<AdminView>(initialView);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [conversationId, setConversationId] = useState('');
  const [computerAgentId, setComputerAgentId] = useState<string>();
  const [refreshing, setRefreshing] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<AdminModal>(null);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const actionRunning = useRef(false);
  const stopState = useRef({
    data,
    overview,
    userId: identity.current.userId,
    owner: !account || account.workspace.role === 'owner',
  });
  stopState.current = {
    data,
    overview,
    userId: identity.current.userId,
    owner: !account || account.workspace.role === 'owner',
  };

  async function refresh() {
    const version = scope.ticket();
    if (!scope.current(version) || !mounted.current) return;
    const request = ++requestSequence.current;
    setRefreshing(true);
    try {
      const [nextOverview, bootstrap] = await Promise.all([
        scope.request<AdminOverview>('/admin/overview'),
        scope.request<Bootstrap>('/bootstrap'),
      ]);
      if (!mounted.current || !scope.current(version) || request !== requestSequence.current)
        return;
      setOverview(nextOverview);
      setData({ ...bootstrap, settings: nextOverview.settings, computer: nextOverview.computer });
      setConversationId((previous) =>
        bootstrap.conversations.some((item) => item.id === previous)
          ? previous
          : bootstrap.conversations.find((item) => !item.demo)?.id ||
            bootstrap.conversations[0]?.id ||
            '',
      );
      setLoadError('');
    } catch (error) {
      if (mounted.current && scope.current(version) && request === requestSequence.current)
        setLoadError((error as Error).message);
    } finally {
      if (mounted.current && scope.current(version) && request === requestSequence.current)
        setRefreshing(false);
    }
  }
  useEffect(() => {
    scope.resume();
    mounted.current = true;
    const previousTitle = document.title;
    document.title = uiText('platform:text_ddb10c1c35a0');
    void refresh();
    const events = new EventSource(workspaceApiUrl('/api/events'));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (document.hidden || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 1200);
    };
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    const hash = () => setView(initialView());
    events.onopen = () => {
      setOnline(true);
      void refresh();
    };
    events.onerror = () => {
      setOnline(false);
      window.dispatchEvent(new Event('openbot:revalidate'));
    };
    events.addEventListener('update', update);
    events.addEventListener('message', update);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('hashchange', hash);
    return () => {
      mounted.current = false;
      scope.suspend();
      requestSequence.current++;
      events.close();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('hashchange', hash);
      document.title = previousTitle;
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  function selectView(next: AdminView) {
    setView(next);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#${next}`,
    );
  }
  async function action(work: () => Promise<unknown>, success?: string) {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    setActionError('');
    try {
      await work();
      await refresh();
      if (mounted.current && success) setNotice(success);
    } catch (error) {
      if (mounted.current) setActionError((error as Error).message);
    } finally {
      actionRunning.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function canStop(id: string) {
    const current = stopState.current;
    return (
      mounted.current &&
      scope.current(scope.ticket()) &&
      !!current.data &&
      !!current.overview?.execution.runningConversations.some((item) => item.id === id) &&
      canStopConversation(current.data.runningRequests, id, {
        userId: current.userId,
        isOwner: current.owner,
      })
    );
  }
  async function stopTask(id: string) {
    const version = scope.ticket();
    if (actionRunning.current || !canStop(id)) return;
    actionRunning.current = true;
    setBusy(true);
    setActionError('');
    try {
      await scope.request(`/conversations/${encodeURIComponent(id)}/stop`, 'POST');
      if (!mounted.current || !scope.current(version)) return;
      await refresh();
      if (mounted.current && scope.current(version))
        setNotice(uiText('platform:text_c8b2ec31f2bf'));
    } catch (error) {
      if (mounted.current && scope.current(version)) setActionError((error as Error).message);
    } finally {
      actionRunning.current = false;
      if (mounted.current && scope.current(version)) setBusy(false);
    }
  }
  async function saveRoutine(body: unknown, id?: string) {
    if (!id) throw Error(uiText('platform:text_71eaee0a3ee9'));
    const ticket = scope.ticket();
    if (!scope.current(ticket)) throw Error(uiText('platform:text_ce2d9676298e'));
    if (actionRunning.current) throw new Error(uiText('platform:text_7d1cf521bdc8'));
    actionRunning.current = true;
    setBusy(true);
    try {
      await scope.request(`/routines/${encodeURIComponent(id)}`, 'PATCH', body);
      if (!mounted.current || !scope.current(ticket)) return;
      await refresh();
      if (mounted.current && scope.current(ticket)) setNotice(uiText('platform:text_f6f363f8dc04'));
    } finally {
      actionRunning.current = false;
      if (mounted.current && scope.current(ticket)) setBusy(false);
    }
  }
  function openRoutine(routine?: Routine) {
    setModal({
      kind: 'routine',
      conversationId: routine?.conversationId || conversationId,
      routineId: routine?.id,
    });
  }
  const activeSection = sections.find((section) => section.id === view)!;
  const skill =
    modal?.kind === 'skill' ? data?.skills.find((item) => item.id === modal.id) : undefined;
  const routineConversation =
    modal?.kind === 'routine'
      ? data?.conversations.find((item) => item.id === modal.conversationId)
      : undefined;
  const panelProps: AdminPanelProps | null =
    data && overview
      ? {
          overview,
          data,
          busy,
          conversationId,
          onConversationChange: setConversationId,
          onView: selectView,
          onModels: () => setModal({ kind: 'settings' }),
          onComputer: () => {
            const conversation = data.conversations.find((item) => item.id === conversationId);
            if (conversation?.agentIds.length === 1) setComputerAgentId(conversation.agentIds[0]);
            setModal({ kind: 'computer' });
          },
          onRoutine: openRoutine,
          onSkill: (item) => setModal({ kind: 'skill', id: item.id }),
          canStop,
          onStop: (id) => void stopTask(id),
        }
      : null;
  const panels = {
    overview: OverviewPanel,
    bots: BotsPanel,
    records: RecordsPanel,
    models: ModelsPanel,
    computer: ComputerPanel,
    automations: AutomationsPanel,
    access: AccessPanel,
  };
  const Panel = panels[view];

  return {
    view,
    selectView,
    account,
    activeSection,
    overview,
    online,
    refreshing,
    refresh,
    loadError,
    data,
    actionError,
    setActionError,
    panelProps,
    Panel,
    notice,
    modal,
    setModal,
    setData,
    setOverview,
    computerAgentId,
    setComputerAgentId,
    conversationId,
    busy,
    action,
    identity,
    scope,
    mounted,
    routineConversation,
    saveRoutine,
    skill,
    actionRunning,
    setBusy,
    setNotice,
  };
}

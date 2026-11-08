import { uiText } from '../i18n';
import { useEffect } from 'react';
import type { Message } from '../../../shared/types';
import { createMobileNavigation, type MobilePage } from '../mobileNavigation';
import { useWorkspaceState } from './useWorkspaceState';
interface EffectsContext {
  workspaceState: ReturnType<typeof useWorkspaceState>;
  navigationScope: string;
  mobileHome: boolean;
  sendScope: {
    current: (ticket: number) => boolean;
    ticket: () => number;
    resume(): void;
    suspend(): void;
    request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  };
  shortcutActions: import('react').RefObject<{
    search: () => void;
    group: () => void;
    settings: () => void;
  }>;
  jumpToMessage: (conversationId: string, messageId?: string) => void;
  messages: Message[];
  selectionKey: string;
  composerKey?: string;
}
export function useWorkspaceEffects({
  workspaceState,
  navigationScope,
  mobileHome,
  sendScope,
  shortcutActions,
  jumpToMessage,
  messages,
  selectionKey,
  composerKey,
}: EffectsContext) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('conversation') || url.searchParams.has('message')) {
      url.searchParams.delete('conversation');
      url.searchParams.delete('message');
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  }, []);
  useEffect(() => {
    if (workspaceState.modal !== 'skills') {
      workspaceState.setSkillsAgentId(undefined);
      workspaceState.setPackagedSkillDraft(undefined);
    }
  }, [workspaceState.modal]);
  useEffect(() => {
    const draft = workspaceState.packagedSkillDraft;
    const staleDraft = draft && draft.scope !== navigationScope;
    workspaceState.setModal((value) =>
      value === 'computer' || value === 'apps' || (value === 'skills' && staleDraft) ? null : value,
    );
    workspaceState.setComputerAgentId(undefined);
  }, [navigationScope]);
  useEffect(() => {
    const pathname = window.location.pathname;
    const navigation =
      workspaceState.mobileNavigation.current &&
      workspaceState.mobileNavigationScope.current === navigationScope
        ? workspaceState.mobileNavigation.current
        : createMobileNavigation({
            history: window.history,
            scope: navigationScope,
            isCurrentScope: () => window.location.pathname === pathname,
            onChange: (page: MobilePage) => {
              const latest = workspaceState.navigationLatest.current;
              const target = page.conversationId;
              if (
                target &&
                (!latest.data || latest.data.conversations.some((c) => c.id === target))
              ) {
                if (workspaceState.selectedRef.current !== target) {
                  workspaceState.jumpRef.current = null;
                  workspaceState.setPendingJump(null);
                  workspaceState.setHighlightedMessage('');
                }
                workspaceState.selectedRef.current = target;
                workspaceState.setSelected(target);
              }
              workspaceState.setMobileChat(page.view !== 'home');
              workspaceState.setShowDetail(page.view === 'details');
              workspaceState.setMenuOpen(false);
            },
          });
    workspaceState.mobileNavigation.current = navigation;
    workspaceState.mobileNavigationScope.current = navigationScope;
    const pop = () => navigation.pop();
    window.addEventListener('popstate', pop);
    return () => {
      navigation.deactivate();
      window.removeEventListener('popstate', pop);
    };
  }, [navigationScope]);
  useEffect(() => {
    const navigation = workspaceState.mobileNavigation.current;
    if (mobileHome) {
      const latest = workspaceState.navigationLatest.current;
      navigation?.activate({
        view: latest.mobileChat ? 'chat' : 'home',
        conversationId: latest.selected,
      });
    } else navigation?.deactivate();
  }, [mobileHome, navigationScope]);
  useEffect(() => {
    if (
      workspaceState.modal ||
      workspaceState.routineChatPending ||
      workspaceState.routineChatFocus.current !== workspaceState.selected
    )
      return;
    workspaceState.routineChatFocus.current = undefined;
    workspaceState.composerRef.current?.focus();
  }, [workspaceState.modal, workspaceState.routineChatPending, workspaceState.selected]);
  useEffect(() => {
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    const timer = setTimeout(
      () => workspaceState.setClockNow(Date.now()),
      Math.max(100, next.getTime() - Date.now() + 50),
    );
    const visible = () => {
      if (!document.hidden) workspaceState.setClockNow(Date.now());
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [workspaceState.clockNow]);
  useEffect(() => {
    function workspaceShortcut(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat || e.altKey) return;
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      const action =
        key === 'k' && !e.shiftKey
          ? 'search'
          : key === 'n' && e.shiftKey
            ? 'group'
            : key === ',' && !e.shiftKey
              ? 'settings'
              : undefined;
      if (!action) return;
      e.preventDefault();
      if (
        !sendScope.current(sendScope.ticket()) ||
        (workspaceState.modalRef.current && workspaceState.modalRef.current !== 'search')
      )
        return;
      shortcutActions.current[action]();
    }
    window.addEventListener('keydown', workspaceShortcut);
    return () => window.removeEventListener('keydown', workspaceShortcut);
  }, [sendScope]);
  useEffect(() => {
    if (!workspaceState.toast) return;
    const t = setTimeout(() => workspaceState.setToast(''), 4500);
    return () => clearTimeout(t);
  }, [workspaceState.toast]);
  useEffect(() => {
    const reset = () => {
      workspaceState.fileDragDepth.current = 0;
      workspaceState.setDraggingFiles(false);
    };
    reset();
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
    };
  }, [workspaceState.selected, workspaceState.modal]);
  useEffect(() => {
    if (
      workspaceState.modal === 'agent' &&
      workspaceState.inspected &&
      workspaceState.data &&
      !workspaceState.data.agents.some((a) => a.id === workspaceState.inspected)
    ) {
      workspaceState.setModal(null);
      workspaceState.setInspected('');
      workspaceState.setToast(uiText('workspace:text_d0096c04446a'));
    }
  }, [workspaceState.modal, workspaceState.inspected, workspaceState.data]);
  useEffect(() => {
    if (!workspaceState.data || !workspaceState.initialMessageLink.current) return;
    const target = workspaceState.initialMessageLink.current;
    workspaceState.initialMessageLink.current = null;
    if (
      !workspaceState.data.messages.some(
        (m) => m.id === target.messageId && m.conversationId === target.conversationId,
      )
    ) {
      workspaceState.jumpRef.current = null;
      workspaceState.setToast(uiText('workspace:text_5e6ad8b0744a'));
      return;
    }
    jumpToMessage(target.conversationId, target.messageId);
  }, [workspaceState.data]);
  useEffect(() => {
    if (workspaceState.jumpRef.current || workspaceState.highlightedMessage) return;
    if (workspaceState.nearBottom.current) {
      workspaceState.scrollRef.current?.scrollTo({
        top: workspaceState.scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
      workspaceState.setUnreadBelow(false);
    } else workspaceState.setUnreadBelow(true);
  }, [composerKey, messages.length, messages.at(-1)?.content]);
  useEffect(() => {
    if (workspaceState.selected) {
      try {
        localStorage.setItem(selectionKey, workspaceState.selected);
      } catch {}
    }
    workspaceState.setReactionPicker(null);
    workspaceState.nearBottom.current = !workspaceState.jumpRef.current;
    workspaceState.setInspected('');
    if (workspaceState.jumpRef.current) return;
    const frame = requestAnimationFrame(() =>
      workspaceState.scrollRef.current?.scrollTo({
        top: workspaceState.scrollRef.current.scrollHeight,
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [workspaceState.selected, selectionKey]);
  useEffect(() => {
    const pendingJump = workspaceState.pendingJump;
    if (
      !pendingJump ||
      workspaceState.selected !== pendingJump.conversationId ||
      workspaceState.modal
    )
      return;
    let frame = 0,
      tries = 0;
    const locate = () => {
      const node = document.getElementById(`message-${pendingJump.messageId}`);
      if (node) {
        node.scrollIntoView({
          block: 'center',
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
        });
        node.focus({ preventScroll: true });
        workspaceState.setHighlightedMessage(pendingJump.messageId);
        workspaceState.setUnreadBelow(false);
        workspaceState.jumpRef.current = null;
        workspaceState.setPendingJump(null);
      } else if (tries++ < 12) {
        frame = requestAnimationFrame(locate);
      } else {
        workspaceState.jumpRef.current = null;
        workspaceState.setPendingJump(null);
        workspaceState.setToast(uiText('workspace:text_5e6ad8b0744a'));
      }
    };
    frame = requestAnimationFrame(locate);
    return () => cancelAnimationFrame(frame);
  }, [workspaceState.pendingJump, workspaceState.selected, workspaceState.modal, messages.length]);
  useEffect(() => {
    if (!workspaceState.highlightedMessage) return;
    const timer = setTimeout(() => workspaceState.setHighlightedMessage(''), 3500);
    return () => clearTimeout(timer);
  }, [workspaceState.highlightedMessage]);
}

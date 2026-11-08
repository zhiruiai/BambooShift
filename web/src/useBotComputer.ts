import { useEffect, useState } from 'react';
import type { ComputerState } from '../../shared/types';
import { createComputerScope, unpreparedScreen, type BotScreenInventory } from './computerScope';

/** Read-only sidebar state. Merely opening a conversation never assigns a screen. */
export function useBotComputer(options: {
  machine?: ComputerState;
  workspaceId?: string;
  userId?: string;
  agentId?: string;
  active: boolean;
}) {
  const { machine, workspaceId, userId, agentId, active } = options;
  const key = JSON.stringify([workspaceId, userId, agentId]);
  const [value, setValue] = useState<{
    key: string;
    computer?: ComputerState;
    inventory?: BotScreenInventory;
    error?: string;
  }>({ key });
  useEffect(() => {
    if (!machine || !active) return;
    const scope = createComputerScope({ workspaceId, userId, agentId });
    let pending = false;
    async function read() {
      if (pending || document.hidden) return;
      pending = true;
      const version = scope.ticket();
      try {
        const [inventory, computer] = await Promise.all([
          scope.request<BotScreenInventory>('/bots', 'GET', undefined, true),
          agentId ? scope.request<ComputerState>('/status') : undefined,
        ]);
        if (scope.current(version)) setValue({ key, inventory, computer });
      } catch (error) {
        if (scope.current(version)) setValue({ key, error: (error as Error).message });
      } finally {
        pending = false;
      }
    }
    void read();
    const timer = setInterval(() => void read(), 6000);
    const visible = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      scope.dispose();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [key, active, !!machine]);
  const current = value.key === key ? value : undefined;
  return {
    computer: current?.computer || (machine ? unpreparedScreen(machine, agentId) : undefined),
    inventory: current?.inventory,
    error: current?.error,
    loaded: !!current?.computer,
  };
}

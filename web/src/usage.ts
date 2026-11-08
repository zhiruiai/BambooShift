import { useEffect, useRef, useState } from 'react';
import { uiText } from './i18n';
import { createPrimaryBotScope } from './primaryBot';

export type UsageDays = 7 | 30 | 90;
export type UsageTotals = {
  modelTurns: number;
  reportedTurns: number;
  unreportedTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};
export type WorkspaceUsage = {
  scope: { workspaceId: string; userId: string; visibility: 'workspace' | 'self' };
  period: { days: UsageDays; since: string; until: string; timeZone: 'UTC' };
  totals: UsageTotals;
  byDay: Array<{ day: string; totals: UsageTotals }>;
  byBot: Array<{ agentId: string | null; name: string | null; totals: UsageTotals }>;
  byModel: Array<{ provider: string; model: string; totals: UsageTotals }>;
  cost: null;
};
const fields: Array<keyof UsageTotals> = [
  'modelTurns',
  'reportedTurns',
  'unreportedTurns',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
];
function validTotals(value: UsageTotals) {
  return (
    !!value &&
    fields.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    value.modelTurns === value.reportedTurns + value.unreportedTurns
  );
}
export function checkedUsage(
  value: WorkspaceUsage,
  identity: { userId?: string; workspaceId?: string },
  days: UsageDays,
) {
  if (
    !value ||
    value.scope?.workspaceId !== identity.workspaceId ||
    value.scope.userId !== identity.userId ||
    !['workspace', 'self'].includes(value.scope.visibility) ||
    value.period?.days !== days ||
    value.period.timeZone !== 'UTC' ||
    !Number.isFinite(Date.parse(value.period.since)) ||
    !Number.isFinite(Date.parse(value.period.until)) ||
    value.cost !== null ||
    !validTotals(value.totals) ||
    !Array.isArray(value.byDay) ||
    !Array.isArray(value.byBot) ||
    !Array.isArray(value.byModel) ||
    !value.byDay.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day) && validTotals(row.totals)) ||
    !value.byBot.every(
      (row) =>
        (row.agentId === null || typeof row.agentId === 'string') &&
        (row.name === null || typeof row.name === 'string') &&
        validTotals(row.totals),
    ) ||
    !value.byModel.every(
      (row) =>
        typeof row.provider === 'string' &&
        typeof row.model === 'string' &&
        validTotals(row.totals),
    )
  ) {
    throw Error(uiText('workspace:usageInvalidResponse'));
  }
  return value;
}
export function useWorkspaceUsage(props: {
  workspaceId?: string;
  userId?: string;
  active?: boolean;
}) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createPrimaryBotScope({ ...props, identity: () => latest.current }),
  );
  const [days, setDays] = useState<UsageDays>(30);
  const [state, setState] = useState<{ loading: boolean; data?: WorkspaceUsage; error: string }>({
    loading: false,
    error: '',
  });
  const order = useRef(0),
    selected = useRef(days);
  selected.current = days;
  const current = () => scope.current(scope.ticket()) && latest.current.active !== false;
  async function read() {
    if (!current() || !props.userId || !props.workspaceId) return;
    const ticket = scope.ticket(),
      sequence = ++order.current,
      period = selected.current;
    setState({ loading: true, error: '' });
    try {
      const value = checkedUsage(
        await scope.request<WorkspaceUsage>(`/usage?days=${period}`),
        props,
        period,
      );
      if (scope.current(ticket) && sequence === order.current && current())
        setState({ loading: false, data: value, error: '' });
    } catch (cause) {
      if (scope.current(ticket) && sequence === order.current && current())
        setState({ loading: false, error: (cause as Error).message });
    }
  }
  useEffect(() => {
    if (props.active !== false) {
      scope.resume();
      void read();
    }
    return () => {
      order.current++;
      scope.suspend();
    };
  }, [scope, props.active, days]);
  return {
    ...state,
    days,
    available: !!props.userId && !!props.workspaceId,
    refresh: read,
    changeDays(value: UsageDays) {
      if (current() && [7, 30, 90].includes(value)) setDays(value);
    },
  };
}

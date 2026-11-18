/** Public synthetic responses used only by the settings layout browser fixture. */
export function settingsLayoutResponse(path: string, workspaceId: string): unknown {
  const prefix = `/api/workspaces/${workspaceId}`;
  const scope = { workspaceId, userId: 'synthetic-owner' };
  if (path === `${prefix}/workspace-time-zone`)
    return { revision: 'synthetic-time-zone', timeZone: 'UTC' };
  if (path === `${prefix}/memory-imports`)
    return {
      available: false,
      reason: 'primary_required',
      primary: {
        available: true,
        revision: 'synthetic-primary',
        agentId: null,
        conversationId: null,
        checkIn: { enabled: false, time: '09:00', timeZone: 'UTC' },
      },
      modelConfigured: true,
    };
  if (path === `${prefix}/usage?days=30`)
    return {
      scope: { ...scope, visibility: 'workspace' },
      period: {
        days: 30,
        since: '2026-01-01T00:00:00Z',
        until: '2026-01-31T00:00:00Z',
        timeZone: 'UTC',
      },
      totals: {
        modelTurns: 0,
        reportedTurns: 0,
        unreportedTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      byDay: [],
      byBot: [],
      byModel: [],
      cost: null,
    };
  if (path === `${prefix}/updates`)
    return {
      scope,
      serviceVersion: '0.0.1',
      repository: null,
      release: null,
      checkedAt: null,
      reason: null,
      status: 'unconfigured',
    };
  return undefined;
}

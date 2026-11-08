/** Public status only. Provider/Worker credentials and infrastructure IDs never appear here. */
export interface CloudComputerState {
  configured: boolean;
  provider?: 'cubesandbox';
  name?: string;
  state: 'unconfigured' | 'running' | 'paused' | 'pausing' | 'unknown';
  expiresAt: string | null;
  observedAt: string;
  operation: { kind: 'start'; startedAt: string } | null;
  worker: { connected: boolean; reconnectRequired: boolean };
  /** Operational readiness; the route separately requires workspace owner permission. */
  canStart: boolean;
  notice?: string;
  error?: { code: string; message: string };
}

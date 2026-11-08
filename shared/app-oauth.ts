export type AppOAuthPhase =
  | 'preparing'
  | 'pending'
  | 'callback_received'
  | 'exchanging'
  | 'complete'
  | 'cancelled'
  | 'expired'
  | 'error';

/** No provider URL query, state, code, verifier, client secret, or token. */
export interface AppOAuthFlow {
  id: string;
  connectionId: string;
  connectionRevision: string;
  appName: string;
  status: AppOAuthPhase;
  expiresAt: string;
  authorizationOrigin?: string;
  issuer?: string;
  scopes: string[];
  /** Same-origin page that verifies the browser account before provider login. */
  launchPath?: string;
  error?: string;
}

export interface StartAppOAuth {
  expectedRevision: string;
  clientId?: string;
  clientSecret?: string;
}

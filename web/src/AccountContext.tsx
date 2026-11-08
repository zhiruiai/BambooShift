import { createContext, useContext } from 'react';
import type { AccountSession, WorkspaceSummary } from '../../shared/platform';
export const AccountContext = createContext<{
  session: AccountSession;
  workspace: WorkspaceSummary;
} | null>(null);
export const useAccount = () => useContext(AccountContext);

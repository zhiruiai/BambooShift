import { createContext, useContext, type ReactNode } from 'react';
import { useAppearance } from './useAppearance';
import { useWorkspaceAvatarTheme } from './useWorkspaceAvatarTheme';

type AvatarThemeContextValue = ReturnType<typeof useWorkspaceAvatarTheme>;
const AvatarThemeContext = createContext<AvatarThemeContextValue | null>(null);

type ScopeProps = { workspaceId: string; userId: string; children: ReactNode };
export function WorkspaceAvatarThemeProvider(props: ScopeProps) {
  return <WorkspaceAvatarThemeScope key={`${props.userId}:${props.workspaceId}`} {...props} />;
}

function WorkspaceAvatarThemeScope({ children, ...identity }: ScopeProps) {
  const sync = useWorkspaceAvatarTheme(identity);
  return <AvatarThemeContext.Provider value={sync}>{children}</AvatarThemeContext.Provider>;
}

export function useAvatarAppearance() {
  const device = useAppearance();
  const sync = useContext(AvatarThemeContext);
  return {
    ...device,
    ...sync?.appearance,
    updateAvatar: sync?.update ?? device.update,
    avatarSync: sync,
  };
}

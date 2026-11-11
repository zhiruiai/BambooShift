import { uiText } from '../i18n';
import { Loader2 } from 'lucide-react';
import { WorkspaceAvatarThemeProvider } from '../avatarAppearance';
import { Avatar } from '../components/Avatar';
import { useWorkspaceController } from './useWorkspaceController';
import { WorkspaceLayout } from './WorkspaceLayout';
export function Workspace() {
  const model = useWorkspaceController();
  const { data, sidebar, loadError, refresh } = model;
  const content =
    !data || !sidebar ? (
      <main className="loading-screen">
        <Avatar size={66} />
        <h1>BambooShift</h1>
        <p>
          {loadError
            ? uiText('workspace:text_2d23d399d69c')
            : uiText('workspace:text_f09d3e238f4e')}
        </p>
        {loadError ? (
          <>
            <small>{loadError}</small>
            <button className="primary-button" onClick={() => void refresh()}>
              {uiText('workspace:text_68891ab35cab')}
            </button>
          </>
        ) : (
          <Loader2 className="spin" size={18} />
        )}
      </main>
    ) : (
      <WorkspaceLayout {...model} data={data} sidebar={sidebar} />
    );
  return model.account && model.currentUserId ? (
    <WorkspaceAvatarThemeProvider
      workspaceId={model.account.workspace.id}
      userId={model.currentUserId}
    >
      {content}
    </WorkspaceAvatarThemeProvider>
  ) : (
    content
  );
}

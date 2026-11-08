import { uiText } from '../i18n';
import { useAccount } from '../AccountContext';
import { currentWorkspaceId } from '../workspace-scope';
import { DeviceSettings } from './DeviceSettings';
import './SettingsDialog.css';
import { Dialog } from './UI';
import { ModelSettingsDialogView } from './modelSettings/ModelSettingsDialogView';
import { SettingsDialogProps } from './modelSettings/parts';
import { useModelSettingsDialog } from './modelSettings/useModelSettingsDialog';
export function SettingsDialog(props: SettingsDialogProps) {
  const account = useAccount();
  const workspaceId = account?.workspace.id || props.workspaceId || currentWorkspaceId();
  const userId = account?.session.user?.id || props.userId;
  if (account && account.workspace.role !== 'owner')
    return (
      <Dialog
        active={props.active}
        title={uiText('settings:text_11345eb54c09')}
        subtitle={uiText('settings:text_f04b8721ec11')}
        onClose={props.onClose}
      >
        <p className="model-settings-note">{uiText('settings:text_61925753f834')}</p>
        <a className="secondary-button" href="/account">
          {uiText('settings:text_109284930f41')}
        </a>
        <DeviceSettings />
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={props.onClose}>
            {uiText('settings:text_c0b3fbff51cc')}
          </button>
        </div>
      </Dialog>
    );
  return (
    <ModelSettingsDialog
      key={`${userId}:${workspaceId}`}
      {...props}
      workspaceId={workspaceId}
      userId={userId}
      showManagement={account?.workspace.role === 'owner'}
    />
  );
}
function ModelSettingsDialog(props: Parameters<typeof useModelSettingsDialog>[0]) {
  const model = useModelSettingsDialog(props);
  return <ModelSettingsDialogView {...model} />;
}

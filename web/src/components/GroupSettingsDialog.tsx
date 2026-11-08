import { GroupSettingsContentView } from './groupSettings/GroupSettingsContentView';
import { Props } from './groupSettings/parts';
import { useGroupSettingsContent } from './groupSettings/useGroupSettingsContent';
import './GroupSettingsDialog.css';
export function GroupSettingsDialog(props: Props) {
  return (
    <GroupSettingsContent
      key={`${props.userId}:${props.workspaceId}:${props.conversation.id}`}
      {...props}
    />
  );
}
function GroupSettingsContent(props: Parameters<typeof useGroupSettingsContent>[0]) {
  const model = useGroupSettingsContent(props);
  return <GroupSettingsContentView {...model} />;
}

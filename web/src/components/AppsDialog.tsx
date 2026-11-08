import './AppsDialog.css';
import { AppsDialogContentView } from './apps/AppsDialogContentView';
import { Props } from './apps/parts';
import { useAppsDialogContent } from './apps/useAppsDialogContent';
export function AppsDialog(props: Props) {
  return (
    <AppsDialogContent
      key={`${props.userId || 'local'}:${props.workspaceId || 'local'}`}
      {...props}
    />
  );
}
function AppsDialogContent(props: Parameters<typeof useAppsDialogContent>[0]) {
  const model = useAppsDialogContent(props);
  return <AppsDialogContentView {...model} />;
}

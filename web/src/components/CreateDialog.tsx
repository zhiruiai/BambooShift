import './BotProfiles.css';
import { CreateDialogContentView } from './creation/CreateDialogContentView';
import { Props } from './creation/parts';
import { useCreateDialogContent } from './creation/useCreateDialogContent';
export function CreateDialog(props: Props) {
  return <CreateDialogContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function CreateDialogContent(props: Parameters<typeof useCreateDialogContent>[0]) {
  const model = useCreateDialogContent(props);
  return <CreateDialogContentView {...model} />;
}

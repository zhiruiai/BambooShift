import './PrimaryBot.css';
import { PrimaryBotContentView } from './primary/PrimaryBotContentView';
import { Props } from './primary/parts';
import { usePrimaryBotContent } from './primary/usePrimaryBotContent';
export function PrimaryBotDialog(props: Props) {
  return <PrimaryBotContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function PrimaryBotContent(props: Parameters<typeof usePrimaryBotContent>[0]) {
  const model = usePrimaryBotContent(props);
  return <PrimaryBotContentView {...model} />;
}

export { PrimaryBotFollowUpStatus } from './primary/parts';
export type { PrimaryBotMode } from './primary/parts';

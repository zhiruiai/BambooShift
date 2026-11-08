import './BotTemplatePage.css';
import './Platform.css';
import { TeamPageView } from './team/TeamPageView';
import { useTeamPage } from './team/useTeamPage';

export function TeamPage(props: Parameters<typeof useTeamPage>[0]) {
  const model = useTeamPage(props);
  return <TeamPageView {...model} />;
}

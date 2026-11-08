import { uiText } from '../i18n';
import './SmartTeamPanel.css';
import { SmartTeamEditorView } from './team/SmartTeamEditorView';
import { SmartTeamHistoryView } from './team/SmartTeamHistoryView';
import { SmartTeamIntroductionView } from './team/SmartTeamIntroductionView';
import { SmartTeamRecoveryView } from './team/SmartTeamRecoveryView';
import type { SmartTeamProps as Props } from './team/types';
import { useSmartTeam } from './team/useSmartTeam';
export function SmartTeamPanel(props: Props) {
  return (
    <SmartTeamContent
      key={`${props.userId}:${props.workspaceId}:${props.initialPlanId || ''}`}
      {...props}
    />
  );
}
function SmartTeamContent(props: Props) {
  const model = useSmartTeam(props);
  return (
    <section className="smart-team-panel" aria-label={uiText('bots:text_5ed92ff52716')}>
      <SmartTeamIntroductionView {...model} />
      <SmartTeamRecoveryView {...model} />
      <SmartTeamEditorView {...model} />
      <SmartTeamHistoryView {...model} />
    </section>
  );
}

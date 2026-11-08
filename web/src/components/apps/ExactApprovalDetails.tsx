import { uiText } from '../../i18n';
import type { ExactApprovalScope } from '../../appApprovalRules';
import './AppApprovalRules.css';

export function ExactApprovalDetails({ scope }: { scope: ExactApprovalScope }) {
  return (
    <dl className="app-approval-scope">
      <dt>{uiText('apps:approvalRuleBot')}</dt>
      <dd>{scope.agentName}</dd>
      <dt>{uiText('apps:approvalRuleConversation')}</dt>
      <dd>{scope.conversationTitle}</dd>
      <dt>{uiText('apps:approvalRuleApp')}</dt>
      <dd>{scope.connectionName}</dd>
      <dt>{uiText('apps:approvalRuleTool')}</dt>
      <dd>
        <code>
          {scope.toolName} · {scope.input.method}
        </code>
      </dd>
      <dt>{uiText('apps:approvalRuleIssue')}</dt>
      <dd>
        <code>
          {scope.input.owner}/{scope.input.repo} #{scope.input.issue_number}
        </code>
      </dd>
    </dl>
  );
}

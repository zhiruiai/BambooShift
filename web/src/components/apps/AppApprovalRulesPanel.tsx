import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { AppApprovalRule } from '../../../../shared/app-connections';
import { parseAppApprovalRules } from '../../appApprovalRules';
import type { createAppConnectionScope } from '../../appConnections';
import { currentLanguage, uiText } from '../../i18n';
import { ExactApprovalDetails } from './ExactApprovalDetails';
import { failed } from './parts';
import './AppApprovalRules.css';

export function AppApprovalRulesPanel({
  scope,
  onBusyChange,
  onChanged,
}: {
  scope: ReturnType<typeof createAppConnectionScope>;
  onBusyChange: (busy: boolean) => void;
  onChanged?: () => void;
}) {
  const [rules, setRules] = useState<AppApprovalRule[]>([]);
  const currentRules = useRef<AppApprovalRule[]>([]);
  const mounted = useRef(false);
  const request = useRef<'read' | 'revoke'>(undefined);
  const sequence = useRef(0);
  const uncertain = useRef(false);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState('');
  const [unclear, setUnclear] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function replaceRules(next: AppApprovalRule[]) {
    currentRules.current = next;
    setRules(next);
  }
  async function refresh() {
    const ticket = scope.ticket();
    if (!mounted.current || !scope.current(ticket) || request.current) return;
    const version = ++sequence.current;
    const current = () => mounted.current && scope.current(ticket) && version === sequence.current;
    request.current = 'read';
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result = parseAppApprovalRules(await scope.request('/apps/approval-rules'));
      if (!current()) return;
      if (!result) throw new Error(uiText('apps:approvalRulesInvalid'));
      replaceRules(result);
      uncertain.current = false;
      setUnclear(false);
    } catch (cause) {
      if (current()) setError(failed(cause));
    } finally {
      if (version === sequence.current) request.current = undefined;
      if (current()) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      sequence.current++;
      if (request.current === 'revoke') onBusyChange(false);
      request.current = undefined;
    };
  }, [scope]);

  async function revoke(id: string) {
    const ticket = scope.ticket();
    const current = () => mounted.current && scope.current(ticket);
    if (
      !current() ||
      request.current ||
      uncertain.current ||
      !currentRules.current.some((rule) => rule.id === id)
    )
      return;
    const version = ++sequence.current;
    request.current = 'revoke';
    setRevoking(id);
    setError('');
    setNotice('');
    onBusyChange(true);
    try {
      const receipt = await scope.request<{ ok?: boolean }>(
        `/apps/approval-rules/${encodeURIComponent(id)}`,
        'DELETE',
      );
      if (!current() || version !== sequence.current) return;
      if (receipt?.ok !== true) throw new Error(uiText('apps:approvalRuleRevokeUnknown'));
      replaceRules(currentRules.current.filter((rule) => rule.id !== id));
      setNotice(uiText('apps:approvalRuleRevoked'));
      onChanged?.();
    } catch {
      if (!current() || version !== sequence.current) return;
      uncertain.current = true;
      setUnclear(true);
      setError(uiText('apps:approvalRuleRevokeUnknown'));
    } finally {
      if (version === sequence.current) {
        request.current = undefined;
        onBusyChange(false);
        if (current()) setRevoking('');
      }
    }
  }

  return (
    <section className="app-approval-rules">
      <div className="app-approval-rules-heading">
        <p className="field-help">{uiText('apps:approvalRulesHelp')}</p>
        <button
          type="button"
          className="secondary-button"
          disabled={loading || !!revoking}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
          {uiText('apps:approvalRulesRefresh')}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="field-help" role="status">
          {notice}
        </p>
      )}
      {loading && !rules.length ? (
        <p className="apps-connections-empty" role="status">
          <Loader2 size={16} className="spin" aria-hidden="true" />
          {uiText('apps:text_d5bf3e74fdb1')}
        </p>
      ) : !rules.length && !error ? (
        <p className="apps-connections-empty" role="status">
          {uiText('apps:approvalRulesEmpty')}
        </p>
      ) : (
        <ul className="app-approval-rule-list">
          {rules.map((rule) => (
            <li key={rule.id}>
              <div className="app-approval-rule-heading">
                <span className="app-approval-audit">
                  <ShieldCheck size={15} aria-hidden="true" />
                  <time dateTime={rule.createdAt}>
                    {new Date(rule.createdAt).toLocaleDateString(currentLanguage())}
                  </time>
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={loading || !!revoking || unclear}
                  aria-label={uiText('apps:approvalRuleRevokeNamed', {
                    issue: `${rule.input.owner}/${rule.input.repo} #${rule.input.issue_number}`,
                    chat: rule.conversationTitle,
                  })}
                  onClick={() => void revoke(rule.id)}
                >
                  {revoking === rule.id && (
                    <Loader2 size={14} className="spin" aria-hidden="true" />
                  )}
                  {uiText('apps:approvalRuleRevoke')}
                </button>
              </div>
              <ExactApprovalDetails scope={rule} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

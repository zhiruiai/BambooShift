import { uiText } from '../../i18n';
import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TemplateSharingMode } from '../../../../shared/bot-templates';
import type { TeamInvitation, TeamMember } from '../../../../shared/platform';
import { createBotTemplateScope, type TemplateIdentity } from '../../botTemplates';
import '../BotTemplatePage.css';
import {
  createSharingPolicyEditor,
  sharingModes,
  type SharingPolicyState,
} from '../botTemplatePageState';
import '../Platform.css';
export type TeamDialog =
  | { kind: 'rename' }
  | { kind: 'member'; member: TeamMember }
  | { kind: 'invitation'; invitation: TeamInvitation }
  | null;
export function BotSharingPolicy({
  workspaceId,
  userId,
  kind,
}: {
  workspaceId: string;
  userId: string;
  kind: 'personal' | 'team';
}) {
  const latest = useRef<TemplateIdentity>({ workspaceId, userId });
  latest.current = { workspaceId, userId };
  const [scope] = useState(() =>
    createBotTemplateScope({ workspaceId, userId, identity: () => latest.current }),
  );
  const [state, setState] = useState<SharingPolicyState>({
    loading: true,
    busy: false,
    needsRefresh: false,
    error: '',
    notice: '',
  });
  const [editor] = useState(() => createSharingPolicyEditor({ scope, kind, onChange: setState }));
  useEffect(() => {
    scope.resume();
    editor.resume();
    void editor.read();
    return () => {
      editor.suspend();
      scope.suspend();
    };
  }, [scope, editor]);
  const labels: Record<TemplateSharingMode, string> = {
    public: uiText('account:text_247242df6a82'),
    'team-only': uiText('account:text_64f0d11e3c86'),
    disabled: uiText('account:text_e5bbc990c196'),
  };
  return (
    <section className="platform-section template-sharing-policy">
      <div className="platform-section-heading">
        <div>
          <h2>{uiText('account:text_3e405a76b117')}</h2>
          <p>{uiText('account:text_c41b839e4ab8')}</p>
        </div>
      </div>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void editor.save();
        }}
      >
        <label>
          {uiText('account:text_d1b2bf593318')}
          <select
            value={state.selection || ''}
            disabled={!state.policy || state.loading || state.busy}
            onChange={(event) => editor.choose(event.target.value as TemplateSharingMode)}
          >
            {!state.policy && <option value="">{uiText('account:text_86b6d0d63062')}</option>}
            {sharingModes(kind).map((mode) => (
              <option key={mode} value={mode}>
                {labels[mode]}
              </option>
            ))}
          </select>
        </label>
        <p className="field-help">{uiText('account:text_3c4b782320c2')}</p>
        {state.error && (
          <p className="platform-error" role="alert">
            {state.error}
          </p>
        )}
        {state.notice && (
          <p className="platform-notice" role="status">
            {state.notice}
          </p>
        )}
        <div className="template-policy-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={state.busy || state.loading}
            onClick={() => void editor.read()}
          >
            {state.loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {uiText('account:text_48e65e11ce7d')}
          </button>
          <button
            className="primary-button"
            disabled={
              state.busy ||
              state.loading ||
              state.needsRefresh ||
              !state.policy ||
              state.selection === state.policy.mode
            }
          >
            {state.busy && <Loader2 size={14} className="spin" />}
            {uiText('account:text_4a1edb18155e')}
          </button>
        </div>
      </form>
    </section>
  );
}

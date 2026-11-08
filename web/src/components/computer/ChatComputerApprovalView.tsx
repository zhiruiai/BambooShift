import { Check, Loader2, RefreshCw, X } from 'lucide-react';
import { uiText } from '../../i18n';
import type { useChatComputerApproval } from './useChatComputerApproval';
import './ChatComputerApproval.css';

export function ChatComputerApprovalView({
  model,
}: {
  model: ReturnType<typeof useChatComputerApproval>;
}) {
  return (
    <div className="chat-computer-approval">
      {model.error && (
        <p className="error-text" role="alert">
          {model.error}
        </p>
      )}
      {model.unknown && (
        <p className="field-help" role="status">
          {uiText('computer:inlineApprovalUnknown')}
        </p>
      )}
      {model.canDecide && (
        <div className="chat-computer-approval-buttons">
          <button
            type="button"
            className="primary-button"
            disabled={model.disabled || model.allowDisabled}
            onClick={() => void model.decide(true)}
          >
            {model.busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            {uiText('computer:inlineAllowOnce')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={model.disabled}
            onClick={() => void model.decide(false)}
          >
            <X size={14} />
            {uiText('computer:inlineDeny')}
          </button>
        </div>
      )}
      {(model.unknown || model.error) && (
        <button
          type="button"
          className="secondary-button chat-computer-approval-refresh"
          disabled={model.busy}
          onClick={() => void model.refresh()}
        >
          <RefreshCw size={13} className={model.busy ? 'spin' : ''} />
          {uiText('computer:inlineApprovalRefresh')}
        </button>
      )}
    </div>
  );
}

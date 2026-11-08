import { useId } from 'react';
import { uiText, type UiTextKey } from '../../i18n';
import { useChatQuestion, type ChatQuestionProps } from './useChatQuestion';
import './ChatQuestionCard.css';

const phaseNotices: Partial<Record<ReturnType<typeof useChatQuestion>['phase'], UiTextKey>> = {
  unavailable: 'workspace:questionUnavailable',
  unknown: 'workspace:questionUnknown',
  retry: 'workspace:questionRetryHelp',
};

export function ChatQuestionCard(props: ChatQuestionProps) {
  const id = useId();
  const {
    question,
    selected,
    requester,
    allowed,
    busy,
    phase,
    failed,
    selectEnabled,
    select,
    respond,
  } = useChatQuestion(props);
  const answered = question.status === 'answered';
  const notice = answered
    ? 'workspace:questionAnswered'
    : !requester
      ? 'workspace:questionReadOnly'
      : !allowed
        ? 'workspace:questionUnavailable'
        : failed
          ? 'workspace:questionFailed'
          : phaseNotices[phase];
  return (
    <form
      className="chat-question-card"
      aria-labelledby={id}
      aria-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void respond();
      }}
    >
      <fieldset disabled={!selectEnabled}>
        <legend id={id}>{question.question}</legend>
        <p className="chat-question-instructions">
          {uiText(
            question.mode === 'single'
              ? 'workspace:questionChooseOne'
              : 'workspace:questionChooseSeveral',
          )}
        </p>
        <div className="chat-question-options">
          {question.options.map((option) => (
            <label key={option.id} className="chat-question-option">
              <input
                type={question.mode === 'single' ? 'radio' : 'checkbox'}
                name={id}
                checked={selected.includes(option.id)}
                onChange={() => select(option.id)}
              />
              <span>
                <strong>{option.label}</strong>
                {option.description && (
                  <span className="chat-question-description">{option.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {notice && (
        <p className="chat-question-status" role="status">
          {uiText(notice)}
        </p>
      )}
      {allowed && phase !== 'unavailable' && (
        <div className="chat-question-actions">
          {phase === 'unknown' || phase === 'checking' ? (
            <button
              type="button"
              className="ghost-button"
              disabled={busy}
              onClick={() => void respond(true)}
            >
              {uiText(
                phase === 'checking' ? 'workspace:questionChecking' : 'workspace:questionCheck',
              )}
            </button>
          ) : (
            <button type="submit" className="primary-button" disabled={busy || !selected.length}>
              {uiText(
                phase === 'sending'
                  ? 'workspace:questionSubmitting'
                  : phase === 'retry'
                    ? 'workspace:questionRetry'
                    : 'workspace:questionSubmit',
              )}
            </button>
          )}
        </div>
      )}
    </form>
  );
}

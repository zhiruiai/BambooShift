import { uiText, type UiTextKey } from '../../i18n';

const labels: Record<string, UiTextKey> = {
  url: 'computer:inlineDetailUrl',
  selector: 'computer:inlineDetailTarget',
  text: 'computer:inlineDetailText',
  content: 'computer:inlineDetailContent',
  path: 'computer:inlineDetailPath',
  command: 'computer:inlineDetailCommand',
  direction: 'computer:inlineDetailDirection',
  x: 'computer:inlineDetailX',
  y: 'computer:inlineDetailY',
  toX: 'computer:inlineDetailToX',
  toY: 'computer:inlineDetailToY',
  deltaX: 'computer:inlineDetailDeltaX',
  deltaY: 'computer:inlineDetailDeltaY',
  key: 'computer:inlineDetailKey',
  button: 'computer:inlineDetailButton',
  clickCount: 'computer:inlineDetailClickCount',
  durationMs: 'computer:inlineDetailDuration',
};

export function ChatComputerRequestView({ payload }: { payload: Record<string, unknown> }) {
  const fields = Object.entries(payload).filter(
    ([key, value]) => labels[key] && (typeof value === 'string' || typeof value === 'number'),
  );
  if (!fields.length) return null;
  return (
    <details className="chat-computer-request">
      <summary>{uiText('computer:inlineApprovalDetails')}</summary>
      <dl>
        {fields.map(([key, value]) => (
          <div key={key}>
            <dt>{uiText(labels[key])}</dt>
            <dd>
              <pre tabIndex={0}>{String(value)}</pre>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

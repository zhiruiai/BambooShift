import { useId } from 'react';
import { uiText } from '../../i18n';
import type { RoutineDraft } from '../../routineDraft';

export function RoutinePublicSearchEditor({
  value,
  onChange,
}: {
  value: RoutineDraft['publicSearch'];
  onChange: (value: NonNullable<RoutineDraft['publicSearch']>) => void;
}) {
  const helpId = useId();
  const enabled = value?.enabled ?? false;
  const text = value?.text ?? '';
  return (
    <div className="routine-public-search">
      <label className="routine-public-search-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onChange({ enabled: event.target.checked, text })}
        />
        <span>{uiText('routines:publicSearchEnable')}</span>
      </label>
      {enabled && (
        <div className="routine-public-search-fields">
          <label>
            {uiText('routines:publicSearchQueries')}
            <textarea
              required
              rows={3}
              aria-describedby={helpId}
              value={text}
              onChange={(event) => onChange({ enabled, text: event.target.value })}
            />
          </label>
          <p className="field-help" id={helpId}>
            {uiText('routines:publicSearchHelp')}
          </p>
        </div>
      )}
    </div>
  );
}

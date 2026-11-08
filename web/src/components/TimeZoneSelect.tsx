import { uiText } from '../i18n';
import { timeZoneOptions } from '../timeZones';
import './TimeZoneSettings.css';

export function TimeZoneSelect({
  value,
  onChange,
  disabled = false,
  label = uiText('settings:text_b5d72c5c00f2'),
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label className="time-zone-select">
      {label}
      <select
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          if (!disabled) onChange(event.target.value);
        }}
      >
        {timeZoneOptions(value).map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}

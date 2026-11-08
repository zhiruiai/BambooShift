import { uiText } from '../../i18n';
import { CornerDownLeft } from 'lucide-react';
import { LINUX_DESKTOP_MAX_TEXT_UNITS } from '../../../../shared/linux-desktop';
export function ComputerTextInput({
  desktop,
  virtual,
  disabled,
  value,
  onChange,
  onSend,
}: {
  desktop: boolean;
  virtual: boolean;
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: (value: string) => void;
}) {
  const tooLong = virtual && value.length > LINUX_DESKTOP_MAX_TEXT_UNITS;
  const blocked = disabled || !value || tooLong;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) onSend(value);
      }}
    >
      <label htmlFor="takeover-text">
        {virtual ? uiText('computer:text_63e599c9b5da') : uiText('computer:text_47f160cda613')}
      </label>
      <div>
        <input
          id="takeover-text"
          type="password"
          autoComplete="off"
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={tooLong || undefined}
          aria-describedby="takeover-text-help"
          placeholder={
            desktop ? uiText('computer:text_78528e40f066') : uiText('computer:text_f62b7174e4ee')
          }
        />
        <button className="secondary-button" disabled={blocked}>
          <CornerDownLeft size={13} />
          {virtual ? uiText('computer:text_8fae9fbef283') : uiText('computer:text_2087c777c06f')}
        </button>
      </div>
      <small id="takeover-text-help" aria-live="polite">
        {uiText('computer:text_b1565ae9e427')}
        {virtual && uiText('computer:text_7b6b17300172', { value0: LINUX_DESKTOP_MAX_TEXT_UNITS })}
        {tooLong && uiText('computer:text_4802427c62f4', { value0: value.length })}
      </small>
    </form>
  );
}
export function ComputerDesktopShortcuts({
  virtual,
  disabled,
  onKey,
}: {
  virtual: boolean;
  disabled: boolean;
  onKey: (key: string) => void;
}) {
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => onKey('ControlOrMeta+C')}>
        {virtual ? 'Ctrl+C' : uiText('computer:text_63d90d977348')}
      </button>
      {!virtual && (
        <button type="button" disabled={disabled} onClick={() => onKey('ControlOrMeta+V')}>
          {uiText('computer:text_335179267471')}
        </button>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onKey(virtual ? 'Alt+Tab' : 'Meta+Space')}
      >
        {virtual ? uiText('computer:text_a7fe8e268584') : uiText('computer:text_cf15f049599c')}
      </button>
    </>
  );
}

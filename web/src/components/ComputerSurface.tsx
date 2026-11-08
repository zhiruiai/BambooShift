import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import { useEffect, useState } from 'react';
import { Check, Info, Loader2, Monitor, ShieldCheck, Square, RefreshCw } from 'lucide-react';
import type { ComputerState } from '../../../shared/types';

export function ComputerSurface({
  computer,
  busy,
  checking,
  onCheck,
  onSelect,
}: {
  computer: ComputerState;
  busy: boolean;
  checking: boolean;
  onCheck: () => void;
  onSelect: (surface: 'browser' | 'desktop') => void;
}) {
  const surface = computer.surface || 'browser';
  const [choice, setChoice] = useState<'browser' | 'desktop'>(surface);
  useEffect(() => setChoice(surface), [surface]);
  const desktop = computer.desktop;
  const virtual = desktop?.kind === 'virtual';
  const desktopLabel = virtual
    ? uiText('computer:text_c255841f6809')
    : uiText('computer:text_5b096afbdb0c');
  const permissionLabel = (state?: string) =>
    state === 'granted'
      ? uiText('computer:text_75d889ac43a2')
      : state === 'denied'
        ? uiText('computer:text_a36cc56b4aa4')
        : uiText('computer:text_3acaa83343cf');
  return (
    <section className="computer-surface" aria-label={uiText('computer:text_0f091d9b51bc')}>
      <div className="surface-heading">
        <span>{uiText('computer:text_573394a6e549')}</span>
        <small>
          {uiText('computer:text_660648805666')}
          {surface === 'desktop' ? desktopLabel : uiText('computer:text_162f582e1060')}
        </small>
      </div>
      <div className="segmented surface-choices">
        <button
          type="button"
          className={choice === 'browser' ? 'active' : ''}
          aria-pressed={choice === 'browser'}
          onClick={() => setChoice('browser')}
        >
          <Square size={14} />
          {uiText('computer:text_162f582e1060')}
        </button>
        <button
          type="button"
          className={choice === 'desktop' ? 'active' : ''}
          aria-pressed={choice === 'desktop'}
          onClick={() => setChoice('desktop')}
        >
          <Monitor size={14} />
          {desktopLabel}
        </button>
      </div>
      {choice === 'desktop' ? (
        <div className="desktop-scope">
          <div className="desktop-scope-title">
            <ShieldCheck size={17} />
            <strong>
              {surface === 'desktop'
                ? uiText('computer:text_2d79d695bea4', { value0: desktopLabel })
                : uiText('computer:text_cbd2de5b5394')}
            </strong>
          </div>
          <p>
            {virtual ? uiText('computer:text_afdc09103f97') : uiText('computer:text_ddaecdb8b133')}
          </p>
          <div className="desktop-permissions">
            <div>
              <span>
                {virtual
                  ? uiText('computer:text_352d280b2be4')
                  : uiText('computer:text_77dfb48bc7ea')}
              </span>
              <strong
                className={desktop?.permissions.screenRecording === 'granted' ? 'granted' : ''}
              >
                {desktop?.permissions.screenRecording === 'granted' && <Check size={12} />}
                {permissionLabel(desktop?.permissions.screenRecording)}
              </strong>
            </div>
            <div>
              <span>
                {virtual
                  ? uiText('computer:text_666b993d8613')
                  : uiText('computer:text_b8f88aeead15')}
              </span>
              <strong className={desktop?.permissions.accessibility === 'granted' ? 'granted' : ''}>
                {desktop?.permissions.accessibility === 'granted' && <Check size={12} />}
                {permissionLabel(desktop?.permissions.accessibility)}
              </strong>
            </div>
          </div>
          {desktop?.reason && (
            <p className="desktop-permission-reason">
              <Info size={13} />
              <span>{serviceText(desktop.reason)}</span>
            </p>
          )}
          {!virtual && desktop?.available && !desktop.authorized && (
            <details className="desktop-permission-help" open>
              <summary>{uiText('computer:text_f09ea1ebacef')}</summary>
              <ol>
                <li>{uiText('computer:text_360b57d93fb6')}</li>
                <li>{uiText('computer:text_12a8fec8e552')}</li>
                <li>{uiText('computer:text_307f1763e9a0')}</li>
                <li>{uiText('computer:text_e47b9af3aa30')}</li>
              </ol>
              <p>{uiText('computer:text_ed533f2f2cff')}</p>
            </details>
          )}
          <div className="surface-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy || checking}
              onClick={onCheck}
            >
              {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              {virtual
                ? uiText('computer:text_c011144dfb94')
                : uiText('computer:text_65208b4d7435')}
            </button>
            {surface !== 'desktop' && (
              <button
                type="button"
                className="primary-button"
                disabled={
                  busy ||
                  checking ||
                  !computer.connected ||
                  !desktop?.available ||
                  !desktop.authorized
                }
                onClick={() => onSelect('desktop')}
              >
                <Monitor size={14} />
                {uiText('computer:text_cdfd0b34e491')}
                {desktopLabel}
              </button>
            )}
          </div>
          {!desktop?.available && (
            <p className="surface-limit">
              {desktopLabel}
              {uiText('computer:text_3e918e481f4e')}
            </p>
          )}
        </div>
      ) : surface === 'desktop' ? (
        <div className="browser-scope">
          <p>{uiText('computer:text_c99609d34a19')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || checking}
            onClick={() => onSelect('browser')}
          >
            {uiText('computer:text_2c47bdbec57a')}
          </button>
        </div>
      ) : (
        <p className="surface-summary">
          {uiText('computer:text_15358e9f7f07')}
          {desktopLabel}
          {uiText('computer:text_0e6ca603c632')}
        </p>
      )}
    </section>
  );
}

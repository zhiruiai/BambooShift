import { uiText } from '../../i18n';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { ComputerDesktopShortcuts, ComputerTextInput } from './ComputerInputControls';
import { type ComputerDialogModel } from './types';

export function ComputerManualControlsView(model: ComputerDialogModel) {
  const {
    isDesktop,
    pointerMode,
    inputBusy,
    setPointerMode,
    setDragStart,
    dragStart,
    virtualDesktop,
    inputText,
    setInputText,
    manual,
  } = model;
  return (
    <>
      <section className="manual-controls" aria-label={uiText('computer:text_1ca4a24dd37a')}>
        {isDesktop && (
          <div className="desktop-pointer-controls">
            <span>{uiText('computer:text_8dcee64f0675')}</span>
            <div className="manual-keyboard">
              {(
                [
                  ['click', uiText('computer:text_1a7289035223')],
                  ['double', uiText('computer:text_26d7c24f77dd')],
                  ['right', uiText('computer:text_3ca47485aee8')],
                  ['drag', uiText('computer:text_0c6b22a75af1')],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={pointerMode === value}
                  className={pointerMode === value ? 'selected' : ''}
                  disabled={inputBusy}
                  onClick={() => {
                    setPointerMode(value);
                    setDragStart(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {pointerMode === 'drag' && (
              <p className="drag-instruction">
                {dragStart
                  ? uiText('computer:text_65e1e891364a')
                  : uiText('computer:text_e72ec4dbe697')}
                {dragStart && (
                  <button type="button" className="text-button" onClick={() => setDragStart(null)}>
                    {uiText('computer:text_35a748c56c2e')}
                  </button>
                )}
              </p>
            )}
          </div>
        )}
        <ComputerTextInput
          desktop={isDesktop}
          virtual={isDesktop && virtualDesktop}
          disabled={inputBusy}
          value={inputText}
          onChange={setInputText}
          onSend={(text) => void manual({ type: 'type', text })}
        />
        <div className="manual-keyboard">
          <button disabled={inputBusy} onClick={() => void manual({ type: 'key', key: 'Enter' })}>
            Enter
          </button>
          <button disabled={inputBusy} onClick={() => void manual({ type: 'key', key: 'Tab' })}>
            Tab
          </button>
          <button
            disabled={inputBusy}
            onClick={() => void manual({ type: 'key', key: 'Backspace' })}
          >
            {uiText('computer:text_d5407b4f3c66')}
          </button>
          <button disabled={inputBusy} onClick={() => void manual({ type: 'key', key: 'Escape' })}>
            Esc
          </button>
          <button
            disabled={inputBusy}
            onClick={() => void manual({ type: 'key', key: 'ControlOrMeta+A' })}
          >
            {isDesktop && virtualDesktop ? 'Ctrl+A' : uiText('computer:text_3a5040b68abf')}
          </button>
          {isDesktop && (
            <ComputerDesktopShortcuts
              virtual={virtualDesktop}
              disabled={inputBusy}
              onKey={(key) => void manual({ type: 'key', key })}
            />
          )}
          <button
            disabled={inputBusy}
            onClick={() => void manual({ type: 'scroll', deltaY: -600 })}
          >
            <ArrowUp size={12} />
            {uiText('computer:text_a5a4b71217ec')}
          </button>
          <button disabled={inputBusy} onClick={() => void manual({ type: 'scroll', deltaY: 600 })}>
            <ArrowDown size={12} />
            {uiText('computer:text_f550790d810f')}
          </button>
        </div>
      </section>
    </>
  );
}

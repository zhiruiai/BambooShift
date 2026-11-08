import { uiText } from '../../i18n';
import { Check, Loader2, Monitor } from 'lucide-react';
import type { ComputerState } from '../../../../shared/types';
import { type ComputerDialogModel } from './types';

export function ComputerConnectionSettingsView(model: ComputerDialogModel) {
  const {
    canManage,
    foldManualConnection,
    manualConnectionOpen,
    busy,
    inputBusy,
    setManualConnectionOpen,
    mode,
    setMode,
    cloudConfigured,
    machine,
    connection,
    scope,
    remote,
    token,
    remoteEdited,
    setRemote,
    setToken,
    connectionPending,
    isDesktop,
    desktopScreenLabel,
  } = model;
  return (
    <>
      <aside className="computer-settings">
        {canManage ? (
          <>
            {foldManualConnection && (
              <button
                type="button"
                className="secondary-button cloud-computer-change"
                aria-expanded={manualConnectionOpen}
                aria-controls="computer-manual-connection"
                disabled={busy || inputBusy}
                onClick={() => setManualConnectionOpen((value) => !value)}
              >
                {manualConnectionOpen
                  ? uiText('computer:text_04b78522ab80')
                  : uiText('computer:text_5bbcd9e0ef22')}
              </button>
            )}
            {(!foldManualConnection || manualConnectionOpen) && (
              <div id="computer-manual-connection">
                <h3>{uiText('computer:text_485a26050ce5')}</h3>
                <div className="segmented">
                  <button
                    type="button"
                    className={mode === 'local' ? 'active' : ''}
                    aria-pressed={mode === 'local'}
                    disabled={busy || inputBusy}
                    onClick={() => setMode('local')}
                  >
                    {uiText('computer:text_8a94c4a1cdbd')}
                  </button>
                  <button
                    type="button"
                    className={mode === 'remote' ? 'active' : ''}
                    aria-pressed={mode === 'remote'}
                    disabled={busy || inputBusy}
                    onClick={() => setMode('remote')}
                  >
                    {uiText('computer:text_7ba00927dde9')}
                  </button>
                </div>
                <p>
                  {mode === 'local'
                    ? uiText('computer:text_ca97e71ac677')
                    : cloudConfigured
                      ? uiText('computer:text_62d31a6db746')
                      : machine.savedRemote
                        ? uiText('computer:text_b0a3825ec9fa')
                        : uiText('computer:text_ce612bf75dde')}
                </p>
                <form
                  className="dialog-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connection(
                      () =>
                        scope.request<ComputerState>(
                          '/connect',
                          'POST',
                          mode === 'local' ? { mode } : { mode, url: remote, token },
                          true,
                        ),
                      uiText('computer:text_af84420bd72d'),
                    );
                  }}
                >
                  {mode === 'remote' && (
                    <>
                      <label>
                        {uiText('computer:text_06488c0767c9')}
                        <input
                          type="url"
                          required
                          disabled={busy || inputBusy}
                          value={remote}
                          onChange={(e) => {
                            remoteEdited.current = true;
                            setRemote(e.target.value);
                          }}
                          placeholder="https://your-worker"
                        />
                      </label>
                      <label>
                        {uiText('computer:text_de228ffca363')}
                        <input
                          type="password"
                          required
                          disabled={busy || inputBusy}
                          autoComplete="off"
                          value={token}
                          onChange={(e) => setToken(e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  <button className="secondary-button" disabled={busy || inputBusy}>
                    {connectionPending === 'connect' ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <Monitor size={15} />
                    )}
                    {connectionPending === 'connect'
                      ? uiText('computer:text_8be0ea36a9bb')
                      : uiText('computer:text_bdd8a3ed7629', {
                          value0:
                            mode === 'local'
                              ? uiText('computer:text_8a94c4a1cdbd')
                              : uiText('computer:text_3535087994d0'),
                        })}
                  </button>
                  {machine.connected && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || inputBusy}
                      onClick={() =>
                        void connection(
                          () =>
                            scope.request<ComputerState>('/disconnect', 'POST', undefined, true),
                          uiText('computer:text_405a76488796'),
                          'disconnect',
                        )
                      }
                    >
                      {uiText('computer:text_a766e7aa0cca')}
                    </button>
                  )}
                </form>
              </div>
            )}
          </>
        ) : (
          <>
            <h3>{uiText('computer:text_2dac75d8b516')}</h3>
            <p>{uiText('computer:text_cd2cd3a1ea72')}</p>
          </>
        )}
        <div className="computer-capabilities">
          <h4>{uiText('computer:text_7958d84e9a3f')}</h4>
          <p>
            <Check size={13} />
            {uiText('computer:text_bea9cb24b63f')}
          </p>
          <p>
            <Check size={13} />
            {isDesktop
              ? uiText('computer:text_4e3be82acb60', { value0: desktopScreenLabel })
              : uiText('computer:text_a1699f87f385')}
          </p>
          <p>
            <Check size={13} />
            {uiText('computer:text_4f751c26f63b')}
          </p>
        </div>
      </aside>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Cloud, Laptop2, Loader2, Monitor, RefreshCw } from 'lucide-react';
import type { ComputerState } from '../../../../shared/types';
import { uiText } from '../../i18n';
import { serviceText } from '../../i18n/serviceText';
import { CloudComputerCard } from '../CloudComputerCard';
import { ComputerWorkerPairing } from './ComputerWorkerPairing';
import type { ComputerDialogModel } from './types';
import './ComputerConnectionSettingsView.css';

const locations = [
  { id: 'server', icon: Monitor },
  { id: 'cloud', icon: Cloud },
  { id: 'remote', icon: Laptop2 },
] as const;
type Location = (typeof locations)[number]['id'];

export function ComputerConnectionSettingsView({
  onWatch,
  ...model
}: ComputerDialogModel & { onWatch?: () => void }) {
  const {
    account,
    machine,
    computer,
    canManage,
    busy,
    inputBusy,
    controlled,
    otherControlled,
    connectionPending,
    connection,
    connectionError,
    cloudState,
    setCloudState,
    cloudPreparing,
    prepareCloudStart,
    mounted,
    setInputBusy,
    clearShot,
    refresh,
    scope,
    setToken,
  } = model;
  const current =
    machine.executionLocation ??
    (machine.connected ? (machine.mode === 'local' ? 'server' : 'remote') : 'none');
  const [choice, setChoice] = useState<Location | null>(null);
  const selected = choice ?? (current === 'none' ? 'server' : current);
  const showPairing = selected === 'remote' && (choice === 'remote' || !machine.connected);
  const showCloud = selected === 'cloud' && (!!onWatch || choice === 'cloud' || !machine.connected);
  const changing = inputBusy || connectionPending !== null;
  const disabled = busy || changing || controlled || otherControlled;
  const pairingSection = useRef<HTMLElement>(null);
  const focusPairing = useRef(false);
  useEffect(() => {
    if (showPairing && focusPairing.current) {
      focusPairing.current = false;
      pairingSection.current?.focus();
    }
  }, [showPairing]);
  function chooseLocation(next: Location) {
    if (selected === 'remote' && next !== 'remote') setToken('');
    setChoice(next);
  }
  function revealPairing() {
    focusPairing.current = true;
    chooseLocation('remote');
  }
  const connectionStatus =
    computer.botScreen?.shared &&
    computer.targetRevision &&
    computer.targetRevision === machine.targetRevision
      ? computer.status
      : machine.status;
  const reconnectAvailable =
    machine.savedRemote &&
    (current !== 'remote' || !machine.connected) &&
    (!account || cloudState?.configured === false);
  const connect = (target: { mode: 'local' } | { mode: 'remote'; url: string; token: string }) =>
    connection(
      () => scope.request<ComputerState>('/connect', 'POST', target, true),
      uiText('computer:text_af84420bd72d'),
    );
  const buttonContent = (label: string, kind: 'connect' | 'disconnect' | 'reconnect') =>
    connectionPending === kind ? (
      <>
        <Loader2 size={14} className="spin" aria-hidden="true" />
        {uiText('computer:text_8be0ea36a9bb')}
      </>
    ) : (
      label
    );
  const desktop = machine.connected ? machine.desktop : undefined;
  return (
    <>
      <section className="computer-location-chooser" aria-labelledby="bot-computer-title">
        <div className="computer-location-heading">
          <div>
            <h3 id="bot-computer-title">{uiText('computer:location_bot_computer')}</h3>
            <p role="status">
              {uiText(
                machine.connected ? `computer:location_${current}` : 'computer:location_none',
              )}
              {machine.connected && machine.name && <> · {machine.name}</>}
              {machine.connected && <> · {uiText('computer:text_5be0323e8adc')}</>}
            </p>
          </div>
          <div className="computer-location-actions">
            {onWatch && (
              <button
                type="button"
                className="secondary-button"
                disabled={changing}
                onClick={onWatch}
              >
                {uiText('computer:location_watch')}
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
            {canManage && machine.connected && (
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() =>
                  void connection(
                    () => scope.request<ComputerState>('/disconnect', 'POST', undefined, true),
                    uiText('computer:text_405a76488796'),
                    'disconnect',
                  )
                }
              >
                {buttonContent(uiText('computer:text_a766e7aa0cca'), 'disconnect')}
              </button>
            )}
          </div>
        </div>
        <div
          className="computer-location-options"
          role="group"
          aria-label={uiText('computer:choose_location')}
        >
          {locations.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="computer-location-option"
              aria-pressed={selected === id}
              aria-label={uiText(`computer:location_choice_${id}`)}
              disabled={changing}
              onClick={() => chooseLocation(id)}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{uiText(`computer:location_choice_${id}`)}</span>
              {current === id && machine.connected && (
                <small>{uiText('computer:location_current')}</small>
              )}
            </button>
          ))}
        </div>
        <div className="computer-location-detail">
          {selected === 'server' && (
            <>
              <p>{uiText('computer:location_help_server')}</p>
              {canManage && (current !== 'server' || !machine.connected) && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => void connect({ mode: 'local' })}
                >
                  {buttonContent(uiText('computer:location_connect_server'), 'connect')}
                </button>
              )}
            </>
          )}
          {showCloud && (!account || cloudState?.configured === false) && (
            <>
              <p>{uiText('computer:location_cloud_unconfigured')}</p>
              {canManage && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={changing}
                  onClick={revealPairing}
                >
                  {uiText('computer:location_connect_own_cloud')}
                </button>
              )}
            </>
          )}
          <CloudComputerCard
            visible={showCloud}
            disabled={disabled}
            onPendingChange={(pending) => {
              if (!pending) cloudPreparing.current = false;
              if (mounted.current) setInputBusy(pending);
            }}
            onPrepareStart={prepareCloudStart}
            onStateChange={setCloudState}
            onStarted={async () => {
              clearShot();
              await refresh();
            }}
          />
          {selected === 'remote' && <p>{uiText('computer:location_help_remote')}</p>}
          {desktop && (
            <p>
              {uiText(
                desktop.kind === 'virtual'
                  ? 'computer:location_virtual_status'
                  : 'computer:location_host_status',
              )}
              {' · '}
              {uiText(
                !desktop.available
                  ? 'computer:location_desktop_unavailable'
                  : desktop.authorized
                    ? 'computer:location_desktop_ready'
                    : 'computer:location_desktop_permissions',
              )}
            </p>
          )}
          {!canManage && <p>{uiText('computer:text_cd2cd3a1ea72')}</p>}
          {connectionError && selected !== 'remote' ? (
            <p className="computer-connection-error" role="alert">
              {connectionError}
            </p>
          ) : (
            connectionStatus && (
              <p className="computer-location-status">{serviceText(connectionStatus)}</p>
            )
          )}
        </div>
      </section>
      {(onWatch || showPairing) && (
        <section
          className="computer-location-chooser"
          aria-labelledby="computer-pairing-title"
          ref={pairingSection}
          tabIndex={-1}
        >
          <div className="computer-location-heading">
            <div>
              <h3 id="computer-pairing-title">{uiText('computer:location_your_computer')}</h3>
              <p>
                {canManage && machine.savedRemote
                  ? uiText('computer:location_saved_computer', { name: machine.savedRemote.name })
                  : uiText('computer:location_pairing_summary')}
              </p>
            </div>
            {canManage && !showPairing && (
              <button
                type="button"
                className="secondary-button"
                disabled={changing}
                onClick={revealPairing}
              >
                {uiText('computer:location_pairing_entry')}
              </button>
            )}
          </div>
          <div className="computer-location-detail">
            <p>{uiText('computer:location_pairing_policy')}</p>
            {showPairing && canManage && (
              <>
                {reconnectAvailable && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={disabled}
                    onClick={() =>
                      void connection(
                        () => scope.request<ComputerState>('/reconnect', 'POST', undefined, true),
                        uiText('computer:text_bcb3994eca59'),
                        'reconnect',
                      )
                    }
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    {buttonContent(uiText('computer:text_992353d9b382'), 'reconnect')}
                  </button>
                )}
                <ComputerWorkerPairing
                  model={model}
                  disabled={disabled}
                  connecting={connectionPending === 'connect'}
                  onConnect={(url, token) => void connect({ mode: 'remote', url, token })}
                />
              </>
            )}
            {showPairing && connectionError && (
              <p className="computer-connection-error" role="alert">
                {connectionError}
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}

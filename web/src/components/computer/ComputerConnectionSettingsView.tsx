import { useState } from 'react';
import { Cloud, Laptop2, Loader2, Monitor, RefreshCw } from 'lucide-react';
import type { ComputerState } from '../../../../shared/types';
import { uiText } from '../../i18n';
import { serviceText } from '../../i18n/serviceText';
import { CloudComputerCard } from '../CloudComputerCard';
import type { ComputerDialogModel } from './types';
import './ComputerConnectionSettingsView.css';

const locations = [
  { id: 'server', icon: Monitor },
  { id: 'cloud', icon: Cloud },
  { id: 'remote', icon: Laptop2 },
] as const;
type Location = (typeof locations)[number]['id'];

export function ComputerConnectionSettingsView(model: ComputerDialogModel) {
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
    remote,
    token,
    remoteEdited,
    setRemote,
    setToken,
  } = model;
  const current =
    machine.executionLocation ??
    (machine.mode === 'local' ? 'server' : machine.connected ? 'remote' : 'none');
  const [choice, setChoice] = useState<Location | null>(null);
  const selected = choice ?? (current === 'none' ? 'server' : current);
  const disabled = busy || inputBusy || controlled || otherControlled || connectionPending !== null;
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
  const connect = (mode: 'local' | 'remote') =>
    connection(
      () =>
        scope.request<ComputerState>(
          '/connect',
          'POST',
          mode === 'local' ? { mode } : { mode, url: remote, token },
          true,
        ),
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
  return (
    <section className="computer-location-chooser" aria-labelledby="computer-location-title">
      <div className="computer-location-heading">
        <div>
          <h3 id="computer-location-title">{uiText('computer:choose_location')}</h3>
          <p role="status">
            {uiText(`computer:location_${current}`)}
            {machine.name && <> · {machine.name}</>}
            {machine.connected && <> · {uiText('computer:text_5be0323e8adc')}</>}
          </p>
        </div>
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
      <div
        className="computer-location-options"
        role="group"
        aria-labelledby="computer-location-title"
      >
        {locations.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="computer-location-option"
            aria-pressed={selected === id}
            aria-label={uiText(`computer:location_choice_${id}`)}
            onClick={() => setChoice(id)}
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
                onClick={() => void connect('local')}
              >
                {buttonContent(uiText('computer:location_connect_server'), 'connect')}
              </button>
            )}
          </>
        )}
        {selected === 'cloud' && (!account || cloudState?.configured === false) && (
          <>
            <p>{uiText('computer:location_cloud_unconfigured')}</p>
            {canManage && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setChoice('remote')}
              >
                {uiText('computer:location_connect_own_cloud')}
              </button>
            )}
          </>
        )}
        <CloudComputerCard
          visible={selected === 'cloud'}
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
        {selected === 'remote' && (
          <>
            <p>
              {uiText('computer:location_help_remote')}{' '}
              {canManage && (
                <a
                  href="https://github.com/zhiruiai/PandaMate/blob/main/docs/computer.md#%E7%8B%AC%E7%AB%8B-worker"
                  target="_blank"
                  rel="noreferrer"
                >
                  {uiText('computer:location_setup_guide')}
                </a>
              )}
            </p>
            {canManage && (
              <div className="computer-location-remote">
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
                <form
                  className="computer-location-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect('remote');
                  }}
                >
                  <label>
                    {uiText('computer:text_06488c0767c9')}
                    <input
                      type="url"
                      required
                      disabled={disabled}
                      value={remote}
                      onChange={(event) => {
                        remoteEdited.current = true;
                        setRemote(event.target.value);
                      }}
                      placeholder="https://"
                    />
                  </label>
                  <label>
                    {uiText('computer:location_credential')}
                    <input
                      type="password"
                      required
                      disabled={disabled}
                      autoComplete="off"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                    />
                  </label>
                  <button type="submit" className="secondary-button" disabled={disabled}>
                    {buttonContent(uiText('computer:location_connect_remote'), 'connect')}
                  </button>
                </form>
              </div>
            )}
          </>
        )}
        {!canManage && <p>{uiText('computer:text_cd2cd3a1ea72')}</p>}
        {connectionError ? (
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
  );
}

import { serviceText } from '../../i18n/serviceText';
import { uiText } from '../../i18n';
import { Loader2, Monitor, RefreshCw } from 'lucide-react';
import type { ComputerState } from '../../../../shared/types';
import { BotScreenPicker, botTaskLabel } from '../BotScreenPicker';
import { CloudComputerCard } from '../CloudComputerCard';
import { ComputerLifecycle } from '../ComputerLifecycle';
import { type ComputerDialogModel } from './types';

function locationLabel(machine: ComputerState) {
  const location = machine.executionLocation ?? (machine.mode === 'local' ? 'server' : 'remote');
  return uiText(`computer:location_${location}`);
}

export function ComputerStatusView(model: ComputerDialogModel) {
  const {
    machine,
    canManage,
    account,
    cloudState,
    busy,
    inputBusy,
    connectionPending,
    connection,
    scope,
    connectionError,
    controlled,
    otherControlled,
    cloudPreparing,
    mounted,
    setInputBusy,
    prepareCloudStart,
    setCloudState,
    clearShot,
    setManualConnectionOpen,
    setMode,
    refresh,
    data,
    agentId,
    inventory,
    preparing,
    finish,
    panel,
    agent,
    computer,
    lifecycleUnknown,
    permissionBusy,
    prepareScreen,
    externalBusy,
    lifecyclePending,
    lifecycleConfirmation,
    lifecycleError,
    lifecycleNotice,
    lifecycleLocalBlock,
    chooseLifecycle,
    setLifecycleConfirmation,
    submitLifecycle,
    checkComputer,
  } = model;
  const connectionStatus =
    computer.botScreen?.shared &&
    computer.targetRevision &&
    computer.targetRevision === machine.targetRevision
      ? computer.status
      : machine.status;
  return (
    <>
      <section
        className={`computer-connection-state ${machine.connected ? 'is-connected' : ''}`}
        aria-label={uiText('computer:text_fdc56c3320de')}
      >
        <div>
          <strong>
            <span className="computer-connection-dot" aria-hidden="true" />
            {machine.connected
              ? uiText('computer:text_5be0323e8adc')
              : machine.mode === 'remote'
                ? uiText('computer:text_c102faa2f659')
                : uiText('computer:text_59a47a0b9d18')}
            {' · '}
            {machine.name}
          </strong>
          <p>{locationLabel(machine)}</p>
          <p role="status">{serviceText(connectionStatus)}</p>
          {machine.savedRemote && (
            <small>
              {uiText('computer:text_fc055f42e202')}
              {machine.savedRemote.name}
            </small>
          )}
        </div>
        {canManage &&
          (!account || cloudState?.configured === false) &&
          (!machine.connected || machine.mode === 'local') &&
          machine.savedRemote && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy || inputBusy || connectionPending !== null}
              onClick={() =>
                void connection(
                  () => scope.request<ComputerState>('/reconnect', 'POST', undefined, true),
                  uiText('computer:text_bcb3994eca59'),
                  'reconnect',
                )
              }
            >
              {connectionPending === 'reconnect' ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {connectionPending === 'reconnect'
                ? uiText('computer:text_90e28b54e030')
                : machine.mode === 'local'
                  ? uiText('computer:switch_saved_remote')
                  : uiText('computer:text_992353d9b382')}
            </button>
          )}
        {connectionError && (
          <p className="computer-connection-error" role="alert">
            {connectionError}
          </p>
        )}
      </section>
      <CloudComputerCard
        disabled={busy || inputBusy || connectionPending !== null || controlled || otherControlled}
        onPendingChange={(pending) => {
          if (!pending) cloudPreparing.current = false;
          if (mounted.current) setInputBusy(pending);
        }}
        onPrepareStart={prepareCloudStart}
        onStateChange={setCloudState}
        onStarted={async (state) => {
          clearShot();
          setManualConnectionOpen(false);
          if (state.worker.connected) setMode('remote');
          await refresh();
        }}
      />
      <BotScreenPicker
        agents={data.agents || []}
        selected={agentId}
        inventory={inventory}
        disabled={busy || inputBusy || preparing || connectionPending !== null}
        onSelect={(id) => {
          if (id !== agentId) void finish(false, id);
        }}
      />
      {panel === 'screen' && (
        <section className="bot-screen-summary" aria-label={uiText('computer:text_e32ecc52b381')}>
          <div>
            <strong>
              {agent
                ? uiText('computer:text_60e92744fead', { value0: agent.name })
                : uiText('computer:text_3d0cdfaab8a0')}
            </strong>
            <p>{serviceText(computer.botScreen?.reason || computer.status)}</p>
            {botTaskLabel(computer.botScreen) && (
              <p role="status">{botTaskLabel(computer.botScreen)}</p>
            )}
            <p>
              {computer.botScreen?.shared
                ? uiText('computer:local_shared_browser')
                : uiText('computer:text_e01450c21d66')}
            </p>
          </div>
          {canManage && agent && computer.botScreen?.status === 'unassigned' && (
            <button
              type="button"
              className="secondary-button"
              disabled={
                busy ||
                inputBusy ||
                preparing ||
                lifecycleUnknown ||
                permissionBusy ||
                !inventory?.capacity.ready ||
                inventory.capacity.assigned >= inventory.capacity.configured
              }
              onClick={() => void prepareScreen()}
            >
              {preparing ? <Loader2 size={14} className="spin" /> : <Monitor size={14} />}
              {uiText('computer:text_8b375e9047ff')}
            </button>
          )}
          {!canManage && computer.botScreen?.status === 'unassigned' && (
            <p className="field-help">{uiText('computer:ask_owner_to_prepare')}</p>
          )}
        </section>
      )}
      {panel === 'screen' && (
        <>
          {computer.botScreen?.status === 'unassigned' &&
            inventory &&
            inventory.capacity.configured > 0 &&
            inventory.capacity.assigned >= inventory.capacity.configured && (
              <p className="field-help">{uiText('computer:text_88d3d22aa7d6')}</p>
            )}
          <ComputerLifecycle
            screen={computer.botScreen}
            name={agent?.name || uiText('computer:text_35c684d6c7d5')}
            owner={canManage}
            busy={externalBusy || inputBusy || preparing || permissionBusy}
            pending={lifecyclePending}
            uncertain={lifecycleUnknown}
            confirmation={lifecycleConfirmation}
            error={lifecycleError}
            notice={lifecycleNotice}
            localBlock={lifecycleLocalBlock}
            onChoose={chooseLifecycle}
            onCancel={() => {
              if (!lifecyclePending) setLifecycleConfirmation(null);
            }}
            onConfirm={() => void submitLifecycle()}
            onRefresh={() => void checkComputer()}
          />
        </>
      )}
    </>
  );
}

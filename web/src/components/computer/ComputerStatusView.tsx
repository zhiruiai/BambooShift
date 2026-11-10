import { serviceText } from '../../i18n/serviceText';
import { uiText } from '../../i18n';
import { Loader2, Monitor } from 'lucide-react';
import { BotScreenPicker, botTaskLabel } from '../BotScreenPicker';
import { ComputerLifecycle } from '../ComputerLifecycle';
import { type ComputerDialogModel } from './types';

export function ComputerStatusView(model: ComputerDialogModel) {
  const {
    canManage,
    busy,
    inputBusy,
    connectionPending,
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
  return (
    <>
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
            <p>
              {serviceText(
                computer.botScreen?.shared
                  ? computer.status
                  : computer.botScreen?.reason || computer.status,
              )}
            </p>
            {botTaskLabel(computer.botScreen) && (
              <p role="status">{botTaskLabel(computer.botScreen)}</p>
            )}
            <p>
              {computer.botScreen?.shared
                ? uiText(
                    computer.surface === 'desktop'
                      ? 'computer:shared_desktop_description'
                      : computer.mode === 'local'
                        ? 'computer:local_shared_browser'
                        : 'computer:remote_shared_browser',
                  )
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

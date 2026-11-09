import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import type { BotAgent, ComputerState } from '../../../shared/types';
import type { BotScreenInventory } from '../computerScope';
import './BotScreenPicker.css';

export function botScreenLabel(screen?: ComputerState['botScreen']) {
  return screen?.status === 'ready'
    ? uiText(screen.shared ? 'computer:shared_screen_label' : 'bots:text_f9b3750987f5')
    : screen?.status === 'unavailable'
      ? uiText('bots:text_f36cac96220b')
      : uiText('bots:text_b3c034ec9fc6');
}
export function botTaskLabel(screen?: ComputerState['botScreen']) {
  if (screen?.lifecycle?.state === 'changing' || screen?.task?.status === 'maintenance')
    return uiText('bots:text_e5a5a5c4328b');
  if (screen?.lifecycle?.state === 'blocked')
    return screen.lifecycle.operation
      ? uiText('bots:text_260c16ab7dc5')
      : uiText('bots:text_b9de09c5a4b5');
  const task = screen?.task;
  if (!task) return '';
  if (screen.status !== 'ready')
    return `${botScreenLabel(screen)}${task.status === 'blocked' ? uiText('bots:text_7f7a75b19582') : ''}${task.queued > 0 ? uiText('bots:text_e062e72cb43f', { value0: task.queued }) : ''}`;
  const state =
    task.status === 'running'
      ? uiText('bots:text_95967c3c6231')
      : task.status === 'waiting_cleanup'
        ? uiText('bots:text_900f68d9b5ef')
        : task.status === 'blocked'
          ? uiText('bots:text_b9de09c5a4b5')
          : uiText('bots:text_dae661d17c2d');
  return `${state}${task.queued > 0 ? uiText('bots:text_e062e72cb43f', { value0: task.queued }) : ''}`;
}
export function BotScreenPicker({
  agents,
  selected,
  onSelect,
  disabled = false,
  inventory,
}: {
  agents: BotAgent[];
  selected?: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  inventory?: BotScreenInventory;
}) {
  return (
    <div className="bot-screen-picker">
      <label>
        {uiText('bots:text_43842baad4eb')}
        <select
          aria-label={uiText('bots:text_aca0cc6f14ba')}
          value={selected || ''}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="" disabled>
            {uiText('bots:text_72d61bad96fc')}
          </option>
          {selected && !agents.some((a) => a.id === selected) && (
            <option value={selected} disabled>
              {uiText('bots:text_5439e197697a')}
            </option>
          )}
          {agents.map((agent) => {
            const screen = inventory?.bots.find((b) => b.agentId === agent.id);
            return (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {screen ? ` · ${botTaskLabel(screen) || botScreenLabel(screen)}` : ''}
              </option>
            );
          })}
        </select>
      </label>
      {inventory && (
        <small>
          {(inventory.shared && uiText('computer:shared_screen_description')) ||
            serviceText(inventory.reason) ||
            (inventory.capacity.configured
              ? uiText('bots:text_a3f91cfb9e4c', {
                  value0: inventory.capacity.assigned,
                  value1: inventory.capacity.configured,
                })
              : uiText('bots:text_e9359d8a0763'))}
        </small>
      )}
    </div>
  );
}

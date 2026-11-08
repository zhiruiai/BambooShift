import { serviceText } from '../../i18n/serviceText';
import { uiText } from '../../i18n';
import type { PrimaryBotState, PrimaryCheckInStatus } from '../../../../shared/primary-bot';
import type { BotAgent } from '../../../../shared/types';
import { confirmedPrimary } from '../../primaryBot';
import { zonedTimeLabel } from '../../timeZones';
import '../PrimaryBot.css';
export type PrimaryBotMode = 'create' | 'select';
export type Props = {
  state?: PrimaryBotState;
  checkInStatus?: PrimaryCheckInStatus;
  agents: BotAgent[];
  workspaceId?: string;
  userId?: string;
  team: boolean;
  personalHref?: string;
  initialMode?: PrimaryBotMode;
  defaultTimeZone?: string;
  onClose: () => void;
  onSaved: (state: PrimaryBotState, confirmed?: ReturnType<typeof confirmedPrimary>) => void;
};
export function PrimaryBotFollowUpStatus({
  state,
  status,
}: {
  state?: PrimaryBotState;
  status?: PrimaryCheckInStatus;
}) {
  if (!state?.available || !state.agentId || !status) return null;
  const label = {
    disabled: uiText('common:text_a188c00c2295'),
    waiting: uiText('common:text_0139582d2b35'),
    running: uiText('common:text_f3a7c2672e48'),
    completed: uiText('common:text_ecbb919a1ccb'),
    interrupted: uiText('common:text_696a6b4863ef'),
    error: uiText('common:text_01b9bc79caeb'),
    no_model: uiText('common:text_a45c7525c4ba'),
  }[status.status];
  const time = status.nextRunAt ? Date.parse(status.nextRunAt) : NaN;
  const planned = Number.isFinite(time) && status.status !== 'disabled';
  return (
    <section
      className="primary-followup-status bot-form-notice"
      aria-label={uiText('common:text_455cd893ab47')}
      role="status"
    >
      <strong>{label}</strong>
      {status.status === 'no_model' && <p>{uiText('common:text_9c08ee726b00')}</p>}
      {(status.status === 'error' || status.status === 'interrupted') && (
        <p>{serviceText(status.reason) || uiText('common:text_af8551a7caa5')}</p>
      )}
      {planned && (
        <p>
          {time > Date.now()
            ? uiText('common:text_4ca6c0e6c9bf')
            : uiText('common:text_eba155bd6fca')}
          {zonedTimeLabel(time, state.checkIn.timeZone)}
        </p>
      )}
      <small>{uiText('common:text_5e2d0a008fdc')}</small>
    </section>
  );
}

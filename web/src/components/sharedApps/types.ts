import { type SharedBotAppGrant } from '../../../../shared/shared-bots';
import type { BotAgent } from '../../../../shared/types';
import { type SharedBotClient } from '../../sharedBots';
import '../SharedBots.css';
export type PickerProps = {
  client: SharedBotClient;
  endpoint: string;
  apps: SharedBotAppGrant[];
  disabled: boolean;
  onChange: (apps: SharedBotAppGrant[]) => void;
  onBusy: (busy: boolean) => void;
};
export type Props = { agent: BotAgent; userId: string };

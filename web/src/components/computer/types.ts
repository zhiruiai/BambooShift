import { currentLanguage } from '../../i18n';
import { uiText, localizedData } from '../../i18n';
import type { Bootstrap } from '../../../../shared/types';
import { type FileComputerAction } from '../ComputerFiles';
import type { useComputerDialog } from './useComputerDialog';
export const time = (v: string) =>
  new Date(v).toLocaleTimeString(currentLanguage(), { hour: '2-digit', minute: '2-digit' });
export const fileSize = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
export type ComputerAction = FileComputerAction;
export type Lease = {
  leaseId: string;
  expiresAt: string;
  width: number;
  height: number;
  surface?: 'browser' | 'desktop';
};
export type TakeoverStatus = {
  active: boolean;
  expiresAt?: string;
  width: number;
  height: number;
  surface?: 'browser' | 'desktop';
};
export const labels: Record<string, string> = localizedData(() => ({
  browser_navigate: uiText('computer:text_bdc799e5677d'),
  browser_click: uiText('computer:text_51fa25e900f7'),
  browser_download: uiText('computer:text_68532ddc30a9'),
  browser_type: uiText('computer:text_6495aeb002d4'),
  terminal_command: uiText('computer:text_e53f35dc006b'),
  remote_shell: uiText('computer:text_2da33b1cff3a'),
  browser_scroll: uiText('computer:text_449dfbcab15f'),
  browser_back: uiText('computer:text_b6050ccef309'),
  list_files: uiText('computer:text_ba2f52ed2e4d'),
  read_file: uiText('computer:text_407dd16f938f'),
  write_file: uiText('computer:text_4d8dc23ed6e1'),
  upload_file: uiText('computer:text_c9f415526a07'),
  download_file: uiText('computer:text_920b2b450375'),
  desktop_click: uiText('computer:text_0b78d4589ab8'),
  desktop_type: uiText('computer:text_7159815dd39f'),
  desktop_key: uiText('computer:text_662b79a3437e'),
  desktop_scroll: uiText('computer:text_1c073c3f680c'),
  desktop_drag: uiText('computer:text_82d8c46e6499'),
}));
export type ComputerDialogProps = {
  data: Bootstrap;
  agentId?: string;
  onSelectBot: (id: string) => void;
  conversationId: string;
  conversationTitle: string;
  initialPanel?: 'screen' | 'files';
  busy: boolean;
  onClose: () => void;
  onAction: (w: () => Promise<unknown>, s?: string) => Promise<void>;
  refresh: () => Promise<void>;
};
export type ComputerDialogModel = ReturnType<typeof useComputerDialog>;

import { uiText } from '../../i18n';
import type { ActionRequester } from '../../../../shared/approvals';
import type { ComputerState } from '../../../../shared/types';
import '../ComputerFiles.css';
export type FileComputerAction = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: string;
  result?: unknown;
  error?: string;
  requester?: ActionRequester;
};
export type TransferContext = {
  computerName: string;
  computerMode: ComputerState['mode'];
  targetRevision?: ComputerState['targetRevision'];
  computerConnected: boolean;
  conversationId: string;
  conversationTitle: string;
};
export const contextKey = (context: TransferContext) =>
  JSON.stringify([
    context.computerName,
    context.computerMode,
    context.targetRevision,
    context.computerConnected,
    context.conversationId,
  ]);
export const unavailableMessage = () => uiText('computer:text_b086309513c9');
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const transferFileSize = (size: number) =>
  size >= 1048576
    ? `${(size / 1048576).toFixed(1)} MB`
    : size >= 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${size} B`;

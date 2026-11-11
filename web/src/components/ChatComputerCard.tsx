import { isComputerReceiptStatusMessage, serviceText } from '../i18n/serviceText';
import { uiText, localizedData } from '../i18n';
import { Check, ChevronRight, FolderOpen, Loader2, Maximize2, Monitor } from 'lucide-react';
import type { Message } from '../../../shared/types';
import { approvalHelp, approvalPendingLabel } from '../approvalUi';
import { ComputerFileSummary } from './ComputerFiles';
import { ComputerFrame } from './ComputerFrame';
import { Markdown } from './Markdown';
import {
  useChatComputerApproval,
  type ChatComputerApprovalProps,
} from './computer/useChatComputerApproval';
import { ChatComputerApprovalView } from './computer/ChatComputerApprovalView';
import { ChatComputerRequestView } from './computer/ChatComputerRequestView';
import { computerActionNeedsApproval, hasAssignedComputerScreen } from './computer/chatApproval';
import {
  RemoteShellDetails,
  RemoteShellResult,
  remoteShellResultStatus,
} from './RemoteShellDetails';

export function ComputerCard({
  message,
  owner,
  userId,
  workspaceId,
  onChanged,
  onClick,
  demo = false,
}: {
  message: Message;
  owner?: boolean;
  userId?: string;
  workspaceId?: string;
  onChanged?: () => Promise<unknown>;
  onClick: () => void;
  demo?: boolean;
}) {
  if (!demo)
    return (
      <ComputerRecord
        key={`${userId}:${workspaceId}:${message.id}:${message.agentId}`}
        message={message}
        onClick={onClick}
        owner={owner}
        userId={userId}
        workspaceId={workspaceId}
        onChanged={onChanged}
      />
    );
  return (
    <div className="computer-message-card">
      <div className="computer-card-title">
        <span>
          <Monitor size={13} />
          {uiText('computer:text_d48f1dcf88d2')}
        </span>
        <span className={`work-status ${message.status === 'running' ? 'running' : ''}`}>
          {message.status === 'running'
            ? uiText('computer:text_dc9591e56d50')
            : message.status === 'error'
              ? uiText('computer:text_03bec2690728')
              : message.status === 'done'
                ? uiText('computer:text_f28461bb49c8')
                : message.metadata?.action
                  ? uiText('computer:text_af680896b7d6')
                  : uiText('computer:text_e894c7ac3243')}
        </span>
      </div>
      <Markdown text={message.content} />
      <button className="work-preview" onClick={onClick}>
        <div className="work-preview-window">
          <div className="work-preview-bar">
            <i />
            <i />
            <i />
            <span>MosoCrew Workspace</span>
          </div>
          <div className="work-preview-content">
            <span className="work-preview-rail">
              <i />
              <i />
              <i />
              <i />
            </span>
            <div>
              <span className="preview-document-heading">
                {uiText('computer:text_6fed7e860168')}
              </span>
              <span className="preview-document-rule" />
              <span className="preview-document-rule short" />
              <span className="preview-document-tile">
                <FolderOpen size={18} />
                <span>{uiText('computer:text_6a0aeb400a76')}</span>
                <ChevronRight size={12} />
              </span>
              <span className="preview-document-tile">
                <Check size={17} />
                <span>{uiText('computer:text_38f71d057e38')}</span>
                <ChevronRight size={12} />
              </span>
            </div>
          </div>
        </div>
        <span className="work-preview-label">
          <Maximize2 size={13} />
          {uiText('computer:text_f53a9e5e29f5')}
        </span>
      </button>
    </div>
  );
}

export const computerActionLabels: Record<string, string> = localizedData(() => ({
  browser_navigate: uiText('computer:text_bdc799e5677d'),
  browser_click: uiText('computer:text_a617f9f6faef'),
  browser_download: uiText('computer:text_68532ddc30a9'),
  browser_type: uiText('computer:text_6495aeb002d4'),
  browser_scroll: uiText('computer:text_f3e6fb138f57'),
  browser_back: uiText('computer:text_b6050ccef309'),
  browser_screenshot: uiText('computer:text_5732a9100f3f'),
  desktop_screenshot: uiText('computer:text_676441b2950e'),
  desktop_click: uiText('computer:text_0b78d4589ab8'),
  desktop_type: uiText('computer:text_609dc493c3d7'),
  desktop_key: uiText('computer:text_4fc34a4651bd'),
  desktop_scroll: uiText('computer:text_1c073c3f680c'),
  desktop_drag: uiText('computer:text_82d8c46e6499'),
  list_files: uiText('computer:text_430994d77e18'),
  read_file: uiText('computer:text_407dd16f938f'),
  write_file: uiText('computer:text_4d8dc23ed6e1'),
  upload_file: uiText('computer:text_c9f415526a07'),
  download_file: uiText('computer:text_920b2b450375'),
  terminal_command: uiText('computer:text_c5cb1328d49b'),
  remote_shell: uiText('computer:text_2da33b1cff3a'),
}));

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function recordLocation(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin + url.pathname;
  } catch {}
  return value.slice(0, 240);
}

export function computerRecordStatus(
  message: Message,
  action: Record<string, unknown>,
): { label: string; kind: string } {
  const status = typeof action.status === 'string' ? action.status : message.status;
  const error = typeof action.error === 'string' ? action.error : '';
  if (message.status === 'error' && (status === 'pending' || status === 'running'))
    return { label: uiText('computer:text_a4dcd29d3cc4'), kind: 'cancelled' };
  if (status === 'pending' && typeof action.type === 'string' && action.type)
    return computerActionNeedsApproval(action.type)
      ? { label: uiText('computer:text_f755b01e2711'), kind: 'pending' }
      : { label: uiText('computer:receiptStarting'), kind: 'starting' };
  if (status === 'running') return { label: uiText('computer:text_dc9591e56d50'), kind: 'running' };
  if (action.type === 'remote_shell' && (status === 'done' || status === 'error')) {
    const outcome = remoteShellResultStatus(action.result);
    if (outcome) return outcome;
  }
  if (status === 'done') return { label: uiText('computer:text_f28461bb49c8'), kind: 'done' };
  if (status === 'rejected') {
    if (/取消|中止/.test(error))
      return { label: uiText('computer:text_a37778f17c5f'), kind: 'cancelled' };
    if (/超时|过期/.test(error))
      return { label: uiText('computer:text_2fe0e3339ac4'), kind: 'cancelled' };
    if (/失效|断开|切换/.test(error))
      return { label: uiText('computer:text_2fe5a8d0eee9'), kind: 'cancelled' };
    return { label: uiText('computer:text_f098218a3032'), kind: 'cancelled' };
  }
  if (status === 'cancelled' || status === 'canceled')
    return { label: uiText('computer:text_a37778f17c5f'), kind: 'cancelled' };
  if (status === 'error') return { label: uiText('computer:text_9344597efd49'), kind: 'error' };
  return { label: uiText('computer:text_e894c7ac3243'), kind: 'record' };
}

export function ComputerRecord(props: ChatComputerApprovalProps & { onClick: () => void }) {
  const { message, onClick, userId } = props;
  const approval = useChatComputerApproval(props);
  const action = approval.action || objectValue(message.metadata?.action),
    payload = objectValue(action.payload),
    result = objectValue(action.result),
    status = computerRecordStatus(message, action);
  const type = typeof action.type === 'string' ? action.type : '';
  const isFileTransfer = type === 'upload_file' || type === 'download_file';
  const isRemoteShell = type === 'remote_shell';
  const pending = status.kind === 'pending';
  const active = status.kind === 'starting' || status.kind === 'running';
  const showActionResult =
    !pending && !active && action.status !== 'pending' && action.status !== 'running';
  const error = typeof action.error === 'string' ? action.error : '';
  const extraMessage =
    !approval.received &&
    message.content !== error &&
    !(approval.action && isComputerReceiptStatusMessage(message.content))
      ? message.content
      : '';
  const target =
    typeof payload.url === 'string'
      ? recordLocation(payload.url)
      : typeof payload.path === 'string'
        ? uiText('computer:text_828e47d89162', { value0: payload.path })
        : typeof payload.command === 'string'
          ? payload.command
          : typeof payload.selector === 'string'
            ? uiText('computer:text_9a6810f63eaa', { value0: payload.selector })
            : typeof payload.key === 'string'
              ? uiText('computer:text_235a154d4756', { value0: payload.key })
              : typeof payload.x === 'number' && typeof payload.y === 'number'
                ? uiText('computer:text_1fbab15bf9eb', { value0: payload.x, value1: payload.y })
                : type.endsWith('_type')
                  ? uiText('computer:text_f433f19552b8')
                  : '';
  const resultText = [
    result.text,
    result.content,
    result.stdout,
    result.stderr,
    typeof action.result === 'string' ? action.result : '',
  ]
    .filter((value): value is string => typeof value === 'string' && !!value)
    .join('\n');
  const entries = Array.isArray(result.entries) ? result.entries.map(objectValue) : undefined;
  const title = typeof result.title === 'string' ? result.title : '';
  const location = typeof result.url === 'string' ? recordLocation(result.url) : '';
  const path = typeof result.path === 'string' && result.path !== payload.path ? result.path : '';
  const bytes = typeof result.bytes === 'number' ? result.bytes : undefined;
  const hasResult =
    title ||
    (location && location !== target) ||
    path ||
    bytes !== undefined ||
    !!entries ||
    resultText;
  return (
    <div className={`computer-message-card computer-record-card record-${status.kind}`}>
      <div className="computer-card-title">
        <span>
          <Monitor size={14} aria-hidden="true" />
          {Object.hasOwn(computerActionLabels, type)
            ? computerActionLabels[type]
            : uiText('computer:text_c9cf30817de5')}
        </span>
        <span className={`work-status status-${status.kind}`} role="status">
          {active && <Loader2 size={12} className="spin" aria-hidden="true" />}
          {pending ? approvalPendingLabel(action.requester, userId) : status.label}
        </span>
      </div>
      {hasAssignedComputerScreen(message, approval.action) && (
        <p className="computer-record-screen">{uiText('computer:receiptAssignedScreen')}</p>
      )}
      {isRemoteShell ? (
        <RemoteShellDetails payload={payload} />
      ) : isFileTransfer ? (
        <ComputerFileSummary
          type={type}
          payload={payload}
          result={showActionResult ? result : undefined}
        />
      ) : (
        target && <div className="computer-record-target">{target}</div>
      )}
      {(pending || extraMessage) && (
        <div className="computer-record-message">
          {pending ? (
            <p>{approvalHelp(action.requester, userId)}</p>
          ) : (
            <Markdown text={extraMessage} />
          )}
        </div>
      )}
      {error && <p className="computer-record-error">{serviceText(error)}</p>}
      {showActionResult && (
        <ComputerFrame frame={action.frame} unavailable={action.frameUnavailable} />
      )}
      {showActionResult && isRemoteShell && Object.keys(result).length > 0 && (
        <RemoteShellResult result={result} />
      )}
      {showActionResult && !isRemoteShell && !isFileTransfer && hasResult && (
        <div className="computer-record-result">
          <span className="record-result-label">{uiText('computer:receiptResult')}</span>
          {title && <strong>{title}</strong>}
          {location && location !== target && <p className="record-result-location">{location}</p>}
          {path && <p className="record-result-location">{path}</p>}
          {bytes !== undefined && (
            <p>
              {uiText('computer:text_3b367ebe9b03')}
              {bytes}
              {uiText('computer:text_f5d87a8b74a0')}
            </p>
          )}
          {entries &&
            (entries.length ? (
              <p>
                {entries.length}
                {uiText('computer:text_041d96aa4db0')}
                {entries
                  .slice(0, 6)
                  .map((entry) =>
                    typeof entry.name === 'string' && entry.name
                      ? entry.name
                      : uiText('computer:text_67bee6acfc3c'),
                  )
                  .join(uiText('common:punct_c4a40ea8fe35'))}
                {entries.length > 6 ? '…' : ''}
              </p>
            ) : (
              <p>{uiText('computer:text_fe6428bcfea8')}</p>
            ))}
          {resultText && (
            <>
              <p className="record-result-excerpt">
                {resultText.slice(0, 240)}
                {resultText.length > 240 ? '…' : ''}
              </p>
              {resultText.length > 240 && (
                <details>
                  <summary>{uiText('computer:text_21f57853693d')}</summary>
                  <pre tabIndex={0}>{resultText.slice(0, 12000)}</pre>
                  {resultText.length > 12000 && (
                    <small>{uiText('computer:text_f04644f58c62')}</small>
                  )}
                </details>
              )}
            </>
          )}
        </div>
      )}
      {pending && !isRemoteShell && !isFileTransfer && (
        <ChatComputerRequestView payload={payload} />
      )}
      <ChatComputerApprovalView model={approval} />
      <button type="button" className="computer-record-open" onClick={onClick}>
        {active ? uiText('computer:receiptViewComputer') : uiText('computer:text_510e7927b89b')}
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

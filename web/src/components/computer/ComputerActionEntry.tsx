import { serviceText } from '../../i18n/serviceText';
import { currentLanguage } from '../../i18n';
import { uiText } from '../../i18n';
import { ChevronDown, FileText, FolderOpen } from 'lucide-react';
import { canDecideAction } from '../../../../shared/approvals';
import { approvalHelp, approvalPendingLabel } from '../../approvalUi';
import { ComputerFileSummary, computerFileDownload } from '../ComputerFiles';
import { FileCard } from '../FileCard';
import {
  RemoteShellDetails,
  RemoteShellResult,
  remoteShellRequestReadable,
  remoteShellResultStatus,
} from '../RemoteShellDetails';
import { fileSize, labels, time, type ComputerAction } from './types';
export function ComputerActionEntry({
  action: a,
  busy,
  controlled,
  owner,
  userId,
  onReject,
  onApprove,
}: {
  action: ComputerAction;
  busy: boolean;
  controlled: boolean;
  owner: boolean;
  userId?: string;
  onReject: () => void;
  onApprove: () => void;
}) {
  const isRemoteShell = a.type === 'remote_shell' || a.type === 'local_shell';
  const isFileTransfer = a.type === 'upload_file' || a.type === 'download_file';
  const outcome =
    isRemoteShell && (a.status === 'done' || a.status === 'error')
      ? remoteShellResultStatus(a.result)
      : undefined;
  return (
    <div className={`computer-action${isRemoteShell ? ' remote-shell-action' : ''}`}>
      <div>
        <span className={`action-dot ${outcome?.kind || a.status}`} />
        <strong>{labels[a.type] || a.type}</strong>
        <small>{time(a.createdAt)}</small>
      </div>
      {isRemoteShell ? (
        <RemoteShellDetails
          payload={a.payload}
          execution={a.type === 'local_shell' ? 'local' : 'isolated'}
        />
      ) : isFileTransfer ? (
        <ComputerFileSummary type={a.type} payload={a.payload} />
      ) : (
        <code>
          {String(
            a.payload.url || a.payload.text || a.payload.command || JSON.stringify(a.payload),
          )}
        </code>
      )}
      {a.error && <p className="error-text">{serviceText(a.error)}</p>}
      {a.status === 'pending' && (
        <p className="field-help">
          {approvalPendingLabel(a.requester, userId)} · {approvalHelp(a.requester, userId)}
        </p>
      )}
      {a.status === 'pending' ? (
        canDecideAction(a.requester, { userId, isOwner: owner }) && (
          <div className="approval-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={onReject}>
              {uiText('computer:text_136de7a8c46f')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                (controlled && !isFileTransfer) ||
                (isRemoteShell && !remoteShellRequestReadable(a.payload))
              }
              onClick={onApprove}
            >
              {uiText('computer:text_58cc5791e024')}
            </button>
          </div>
        )
      ) : (
        <span className="action-result">
          {outcome?.label ||
            {
              done: uiText('computer:text_f28461bb49c8'),
              rejected: uiText('computer:text_f098218a3032'),
              error: uiText('computer:text_9344597efd49'),
              running: uiText('computer:text_5026a63b58cd'),
            }[a.status] ||
            a.status}
        </span>
      )}
      {a.result !== undefined &&
        (isRemoteShell ? (
          <RemoteShellResult result={a.result} />
        ) : (
          <ComputerResult result={a.result} requestedAt={a.createdAt} />
        ))}
    </div>
  );
}
export function ComputerResult({ result, requestedAt }: { result: unknown; requestedAt: string }) {
  const value =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const download = computerFileDownload(result);
  const controlNames: Record<string, string> = {
    a: uiText('computer:text_305378ddd2b8'),
    button: uiText('computer:text_ad1c50c9367c'),
    input: uiText('computer:text_8a5dcce3a970'),
    textarea: uiText('computer:text_beade57a72f1'),
    select: uiText('computer:text_c60286515bfe'),
  };
  const controls = Array.isArray(value.controls)
    ? (value.controls.filter((c) => c && typeof c === 'object') as Record<string, unknown>[])
    : [];
  const entries = Array.isArray(value.entries)
    ? (value.entries.filter((e) => e && typeof e === 'object') as Record<string, unknown>[])
    : [];
  const visibleText = [value.text, value.content, value.stdout]
    .filter((v) => typeof v === 'string' && v)
    .join('\n');
  const known = Boolean(
    download ||
    value.name ||
    value.size !== undefined ||
    value.url ||
    value.title ||
    value.path ||
    visibleText ||
    value.stderr ||
    value.bytes !== undefined ||
    Array.isArray(value.entries) ||
    Array.isArray(value.controls),
  );
  return (
    <details className="computer-result">
      <summary>
        {uiText('computer:text_3cd07b48dd82')}
        <ChevronDown size={13} />
      </summary>
      <div className="computer-result-body">
        <p className="result-request-time">
          {uiText('computer:text_60f7ab08413f')}
          {new Date(requestedAt).toLocaleString(currentLanguage(), { hour12: false })}
        </p>
        {typeof value.title === 'string' && value.title && <h4>{value.title}</h4>}
        {!download && typeof value.name === 'string' && (
          <h4>
            {value.name}
            {typeof value.size === 'number' && ` · ${fileSize(value.size)}`}
          </h4>
        )}
        {download &&
          (typeof value.name === 'string' && value.name.trim() ? (
            <FileCard
              name={value.name}
              size={typeof value.size === 'number' ? value.size : 0}
              href={download}
            />
          ) : (
            <a className="computer-file-download" href={download} download>
              <FileText size={13} />
              {uiText('computer:text_5f097da3c79b')}
            </a>
          ))}
        {typeof value.url === 'string' && <p className="result-url">{value.url}</p>}
        {typeof value.path === 'string' && (
          <p className="result-path">
            <FolderOpen size={13} />
            {value.path}
          </p>
        )}
        {visibleText && (
          <div className="result-text">
            <span className="result-label">
              {value.text
                ? uiText('computer:text_9e6b560afc57')
                : uiText('computer:text_41e1886371ff')}
            </span>
            <pre>{visibleText}</pre>
          </div>
        )}
        {typeof value.stderr === 'string' && value.stderr && (
          <div className="result-text">
            <span className="result-label">{uiText('computer:text_dbf4d7a56557')}</span>
            <pre>{value.stderr}</pre>
          </div>
        )}
        {typeof value.bytes === 'number' && (
          <p className="result-label">
            {uiText('computer:text_c2e69b675c2e')}
            {fileSize(value.bytes)}
          </p>
        )}
        {Array.isArray(value.entries) && (
          <div className="result-file-list">
            <span className="result-label">
              {entries.length}
              {uiText('computer:text_1d22ffe8f185')}
            </span>
            {entries.map((entry, i) => (
              <p key={i}>
                {entry.type === 'directory' ? <FolderOpen size={13} /> : <FileText size={13} />}
                <span>{String(entry.name || uiText('computer:text_67bee6acfc3c'))}</span>
              </p>
            ))}
          </div>
        )}
        {Array.isArray(value.controls) && (
          <div className="result-controls">
            <span className="result-label">
              {uiText('computer:text_4638af92c724')}
              {controls.length}
            </span>
            {controls.length ? (
              controls.map((control, i) => (
                <div key={i}>
                  <span>
                    {controlNames[String(control.tag)] || uiText('computer:text_d077caef2ce1')}
                  </span>
                  <p>
                    {String(
                      control.text ||
                        control.placeholder ||
                        control.name ||
                        control.id ||
                        uiText('computer:text_67bee6acfc3c'),
                    )}
                    {typeof control.href === 'string' && control.href && (
                      <small>{control.href}</small>
                    )}
                  </p>
                </div>
              ))
            ) : (
              <p className="result-label">{uiText('computer:text_6abe683e069d')}</p>
            )}
          </div>
        )}
        {!known && (
          <pre className="result-fallback">
            {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

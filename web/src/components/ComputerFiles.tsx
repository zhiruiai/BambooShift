import { uiText } from '../i18n';
import {
  ArrowUp,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  Monitor,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { MAX_FILE_TRANSFER_BYTES, type ComputerFileListing } from '../../../shared/computer-files';
import type { ComputerState } from '../../../shared/types';
import { useFixedWorkspaceApi } from '../useFixedWorkspaceApi';
import './ComputerFiles.css';
import { IconButton } from './UI';
import { TransferStatus } from './computerFiles/TransferStatus';
import { modifiedTime, parentPath } from './computerFiles/filePaths';
import { TransferContext, transferFileSize } from './computerFiles/types';
import { useComputerTransfer } from './computerFiles/useComputerTransfer';
export { computerFileDownload, ComputerFileSummary } from './computerFiles/FileSummary';
export { SendFileToComputerDialog } from './computerFiles/SendFileToComputerDialog';
export type { FileComputerAction } from './computerFiles/types';
export function ComputerFiles({
  computer,
  conversationId,
  conversationTitle,
  refresh,
}: {
  computer: ComputerState;
  conversationId: string;
  conversationTitle: string;
  refresh: () => Promise<void>;
}) {
  const { api, current } = useFixedWorkspaceApi();
  const [path, setPath] = useState('.'),
    [listing, setListing] = useState<ComputerFileListing | null>(null),
    [loading, setLoading] = useState(false),
    [listError, setListError] = useState(''),
    [revision, setRevision] = useState(0);
  const currentContext: TransferContext = {
    computerName: computer.name || uiText('computer:text_6205c8a9a2b9'),
    computerMode: computer.mode,
    targetRevision: computer.targetRevision,
    computerConnected: computer.connected,
    conversationId,
    conversationTitle,
  };
  const transfer = useComputerTransfer(refresh, currentContext);
  useEffect(() => {
    setPath('.');
    setListing(null);
  }, [computer.connected, computer.name, computer.mode, computer.targetRevision]);
  useEffect(() => {
    let active = true;
    setListing(null);
    setListError('');
    if (!computer.connected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void api<ComputerFileListing>(`/computer/files?path=${encodeURIComponent(path)}`)
      .then((value) => {
        if (active && current()) setListing(value);
      })
      .catch((cause) => {
        if (active && current()) setListError((cause as Error).message);
      })
      .finally(() => {
        if (active && current()) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [computer.connected, computer.name, computer.mode, computer.targetRevision, path, revision]);
  const currentPath = listing?.path || path;
  return (
    <section className="computer-files" aria-label={uiText('computer:text_003d6ad3918e')}>
      <div className="computer-files-intro">
        <FolderOpen size={20} />
        <div>
          <h3>{uiText('computer:text_003d6ad3918e')}</h3>
          <p>
            {uiText('computer:text_2e22e9760f12')}
            {computer.name || uiText('computer:text_6205c8a9a2b9')}
            {uiText('computer:text_082d84d07dae')}
            {conversationTitle || uiText('computer:text_9800a458c16b')}
            {uiText('computer:text_44b623e15e17')}
          </p>
        </div>
      </div>
      <div className="computer-files-toolbar">
        <IconButton
          label={uiText('computer:text_cecc0beb8af6')}
          disabled={loading || currentPath === '.' || currentPath === '' || !computer.connected}
          onClick={() => setPath(parentPath(currentPath))}
        >
          <ArrowUp size={16} />
        </IconButton>
        <span title={currentPath}>
          {currentPath === '.'
            ? uiText('computer:text_37979829426b')
            : uiText('computer:text_043ad73d570e', { value0: currentPath })}
        </span>
        <IconButton
          label={uiText('computer:text_3b8c4b3f9887')}
          disabled={loading || !computer.connected}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </IconButton>
      </div>
      {!computer.connected ? (
        <div className="computer-files-empty">
          <Monitor size={26} />
          <p>{uiText('computer:text_31b0e2e24882')}</p>
        </div>
      ) : loading ? (
        <div className="computer-files-empty">
          <Loader2 size={23} className="spin" />
          <p>{uiText('computer:text_2fef5037d4cb')}</p>
        </div>
      ) : listError ? (
        <div className="computer-files-error" role="alert">
          <Info size={16} />
          <span>{listError}</span>
          <button className="text-button" onClick={() => setRevision((value) => value + 1)}>
            {uiText('computer:text_b8784c8dd563')}
          </button>
        </div>
      ) : listing && !listing.entries.length ? (
        <div className="computer-files-empty">
          <FolderOpen size={27} />
          <p>{uiText('computer:text_fe6428bcfea8')}</p>
        </div>
      ) : (
        <div className="computer-files-list">
          {listing?.entries.map((entry) => (
            <div className="computer-file-row" key={entry.path}>
              {entry.kind === 'directory' ? <FolderOpen size={19} /> : <FileText size={19} />}
              <div>
                <button
                  type="button"
                  className="computer-file-name"
                  disabled={entry.kind !== 'directory'}
                  onClick={() => setPath(entry.path)}
                >
                  {entry.name}
                </button>
                <small>
                  {entry.kind === 'directory'
                    ? uiText('computer:text_7c7802d8adae')
                    : typeof entry.size === 'number'
                      ? transferFileSize(entry.size)
                      : uiText('computer:text_39932f24fe11')}
                  {entry.modifiedAt ? ` · ${modifiedTime(entry.modifiedAt)}` : ''}
                </small>
              </div>
              {entry.kind === 'directory' ? (
                <IconButton
                  label={uiText('computer:text_29ee30ae8345', { value0: entry.name })}
                  onClick={() => setPath(entry.path)}
                >
                  <ChevronRight size={16} />
                </IconButton>
              ) : (
                <button
                  type="button"
                  className="computer-file-import"
                  disabled={
                    transfer.active ||
                    !conversationId ||
                    (transfer.action?.status === 'done' &&
                      transfer.action.type === 'download_file' &&
                      transfer.action.payload.path === entry.path) ||
                    (entry.size !== undefined && entry.size > MAX_FILE_TRANSFER_BYTES)
                  }
                  title={
                    entry.size !== undefined && entry.size > MAX_FILE_TRANSFER_BYTES
                      ? uiText('computer:text_94bfe6b151ad')
                      : uiText('computer:text_edf4c1802fc2', { value0: entry.name })
                  }
                  onClick={() =>
                    void transfer.perform(
                      {
                        type: 'download_file',
                        path: entry.path,
                        conversationId,
                      },
                      currentContext,
                    )
                  }
                >
                  <Download size={14} />
                  <span>
                    {transfer.action?.status === 'done' &&
                    transfer.action.type === 'download_file' &&
                    transfer.action.payload.path === entry.path
                      ? uiText('computer:text_cb112735e089')
                      : uiText('computer:text_7726ff8b979e')}
                  </span>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {listing?.truncated && <p className="field-help">{uiText('computer:text_9ebf601a3f36')}</p>}
      <p className="field-help computer-files-limit">{uiText('computer:text_e7d69e6f7e72')}</p>
      <TransferStatus
        action={transfer.action}
        context={transfer.context}
        error={transfer.error}
        requesting={transfer.requesting}
      />
    </section>
  );
}

import { uiText } from '../../i18n';
import { FileText, Loader2, Monitor, Upload } from 'lucide-react';
import { useState } from 'react';
import { MAX_FILE_TRANSFER_BYTES } from '../../../../shared/computer-files';
import type { ComputerState, WorkspaceFile } from '../../../../shared/types';
import '../ComputerFiles.css';
import { Dialog } from '../UI';
import { TransferStatus } from './TransferStatus';
import { TransferContext, transferFileSize } from './types';
import { useComputerTransfer } from './useComputerTransfer';
export function SendFileToComputerDialog({
  file,
  computer,
  conversationId,
  conversationTitle,
  onClose,
  refresh,
}: {
  file: WorkspaceFile;
  computer: ComputerState;
  conversationId: string;
  conversationTitle: string;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [path, setPath] = useState(() => file.name.split(/[\\/]/).pop() || file.name);
  const [validation, setValidation] = useState('');
  const currentContext: TransferContext = {
    computerName: computer.name || uiText('computer:text_6205c8a9a2b9'),
    computerMode: computer.mode,
    targetRevision: computer.targetRevision,
    computerConnected: computer.connected,
    conversationId,
    conversationTitle,
  };
  const transfer = useComputerTransfer(refresh, currentContext);
  const tooLarge = file.size > MAX_FILE_TRANSFER_BYTES;
  return (
    <Dialog
      title={uiText('computer:text_8272cf0a0f36')}
      subtitle={uiText('computer:text_31f466588b54')}
      onClose={onClose}
    >
      <form
        className="dialog-form computer-file-send"
        onSubmit={(event) => {
          event.preventDefault();
          const value = path.trim();
          if (
            !value ||
            value.startsWith('/') ||
            value.includes('\\') ||
            value.split('/').some((part) => !part || part === '.' || part === '..')
          ) {
            setValidation(uiText('computer:text_1db25e3f7a62'));
            return;
          }
          setValidation('');
          if (!computer.connected || tooLarge || transfer.active) return;
          void transfer.perform(
            {
              type: 'upload_file',
              fileId: file.id,
              path: value,
              conversationId,
            },
            currentContext,
          );
        }}
      >
        <div className="file-send-source">
          <FileText size={24} />
          <div>
            <strong>{file.name}</strong>
            <small>
              {transferFileSize(file.size)} · {conversationTitle}
              {uiText('computer:text_433bdcb25776')}
            </small>
          </div>
        </div>
        <div className="file-send-target">
          <Monitor size={17} />
          <span>
            {uiText('computer:text_1f18a2ec1bd9')}
            <strong>{computer.name || uiText('computer:text_bca58df75396')}</strong>
            <small>
              {computer.mode === 'remote'
                ? uiText('computer:text_5de18b2896b4')
                : uiText('computer:text_cf901529e149')}
            </small>
          </span>
        </div>
        <label>
          {uiText('computer:text_6c32de29ef8f')}
          <input
            required
            value={path}
            disabled={transfer.active}
            onChange={(event) => {
              setPath(event.target.value);
              setValidation('');
              transfer.reset();
            }}
            placeholder={uiText('computer:text_ab3a8bc5c1d2')}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="field-help">{uiText('computer:text_f21a47283754')}</p>
        {!computer.connected && (
          <p className="computer-files-error">{uiText('computer:text_7e6874e9e06c')}</p>
        )}
        {tooLarge && <p className="computer-files-error">{uiText('computer:text_3acde348049d')}</p>}
        {validation && (
          <p className="computer-files-error" role="alert">
            {validation}
          </p>
        )}
        <TransferStatus
          action={transfer.action}
          context={transfer.context}
          error={transfer.error}
          requesting={transfer.requesting}
        />
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {transfer.action?.status === 'done'
              ? uiText('computer:text_c0b3fbff51cc')
              : uiText('computer:text_3fd47edce45b')}
          </button>
          <button
            className="primary-button"
            disabled={
              !computer.connected ||
              tooLarge ||
              transfer.active ||
              transfer.action?.status === 'done' ||
              !path.trim()
            }
          >
            {transfer.active ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}{' '}
            {transfer.active
              ? uiText('computer:text_22eb0f8779ab')
              : transfer.action?.status === 'done'
                ? uiText('computer:text_60823aaec73b')
                : transfer.action?.status === 'unavailable'
                  ? uiText('computer:text_b38bf1a894e7')
                  : transfer.action?.status === 'pending'
                    ? uiText('computer:text_c8cee19555fa')
                    : transfer.error
                      ? uiText('computer:text_6820f44987bb')
                      : uiText('computer:text_e7281fbca7af')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

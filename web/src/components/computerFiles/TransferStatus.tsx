import { uiText } from '../../i18n';
import { Check, Info, Loader2 } from 'lucide-react';
import '../ComputerFiles.css';
import { ComputerFileSummary } from './FileSummary';
import { FileComputerAction, TransferContext } from './types';
export function TransferStatus({
  action,
  context,
  error,
  requesting,
}: {
  action: FileComputerAction | null;
  context: TransferContext | null;
  error: string;
  requesting: boolean;
}) {
  if (!action && !error && !requesting) return null;
  const status = requesting
    ? uiText('computer:text_cb25c9cbe9e8')
    : action?.status === 'done'
      ? action.type === 'download_file'
        ? uiText('computer:text_281ea5759aef', {
            value0: context?.conversationTitle || uiText('computer:text_795e056e1f9f'),
          })
        : uiText('computer:text_33a155f7772b', {
            value0: context?.computerName || uiText('computer:text_58b74358793a'),
          })
      : action?.status === 'running'
        ? uiText('computer:text_cb25c9cbe9e8')
        : action?.status === 'pending'
          ? uiText('computer:text_1e047f37e14f')
          : action?.status === 'rejected'
            ? uiText('computer:text_9596d1ac92cd')
            : action?.status === 'unavailable'
              ? uiText('computer:text_1f099a64b59d')
              : action?.status === 'error'
                ? uiText('computer:text_e7fa8bf6d52c')
                : '';
  return (
    <div className={`file-transfer-status ${error ? 'has-error' : ''}`} role="status">
      <strong>
        {requesting || action?.status === 'running' ? (
          <Loader2 size={14} className="spin" />
        ) : action?.status === 'done' ? (
          <Check size={14} />
        ) : (
          <Info size={14} />
        )}{' '}
        {status || uiText('computer:text_27c13fddc733')}
      </strong>
      {context && (
        <p className="file-transfer-context">
          {uiText('computer:text_2cd0a0a3b91b')}
          {context.computerName}
          {uiText('common:punct_da047c04c9b5')}
          {context.computerMode === 'remote'
            ? uiText('computer:text_7ba00927dde9')
            : uiText('computer:text_8a94c4a1cdbd')}
          {uiText('common:punct_f2e44c6c9545')}
          <br />
          {uiText('computer:text_be9fc3c50778')}
          {context.conversationTitle}
        </p>
      )}
      {action && (
        <ComputerFileSummary type={action.type} payload={action.payload} result={action.result} />
      )}
      {error && <p>{error}</p>}
    </div>
  );
}

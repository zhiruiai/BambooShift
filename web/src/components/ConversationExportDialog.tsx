import { useEffect, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import type { ConversationExport } from '../../../shared/conversation-export';
import { createAppConnectionScope } from '../appConnections';
import { createConversationExport } from '../conversationExport';
import { currentLanguage, uiText } from '../i18n';
import { ApiError } from '../api';
import { Dialog } from './UI';
import './ConversationExportDialog.css';

export function ConversationExportDialog({
  conversationId,
  workspaceId,
  userId,
  current,
  onClose,
}: {
  conversationId: string;
  workspaceId: string;
  userId: string;
  current: () => boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<ConversationExport>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const jobRef = useRef<ReturnType<typeof createConversationExport>>(undefined);
  const mountedRef = useRef(false);
  useEffect(() => {
    const job = createConversationExport(
      createAppConnectionScope({
        workspaceId,
        userId,
        identity: () => (current() ? { workspaceId, userId } : {}),
      }),
      conversationId,
      current,
    );
    jobRef.current = job;
    mountedRef.current = true;
    setBusy(true);
    setData(undefined);
    setError('');
    let mounted = true;
    void job
      .load(currentLanguage())
      .then((value) => {
        if (mounted) setData(value);
      })
      .catch((cause: unknown) => {
        if (mounted) failure(cause);
      })
      .finally(() => {
        if (mounted) setBusy(false);
      });
    return () => {
      mounted = false;
      mountedRef.current = false;
      job.close();
    };
  }, [workspaceId, userId, conversationId, current]);
  function failure(cause: unknown) {
    setError(
      uiText(
        cause instanceof ApiError && cause.code === 'CONVERSATION_EXPORT_TOO_LARGE'
          ? 'workspace:exportTooLarge'
          : 'workspace:exportFailed',
      ),
    );
  }
  async function deliver(copy: boolean) {
    const job = jobRef.current;
    if (!data || busy || !job) return;
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      await job.deliver(data, async (value) => {
        if (copy) {
          await navigator.clipboard.writeText(value.content);
          if (mountedRef.current) setCopied(true);
        } else {
          const url = URL.createObjectURL(
            new Blob([value.content], { type: 'text/markdown;charset=utf-8' }),
          );
          const link = document.createElement('a');
          link.href = url;
          link.download = value.filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      });
    } catch (cause) {
      if (mountedRef.current && current()) failure(cause);
    } finally {
      if (mountedRef.current && current()) setBusy(false);
    }
  }
  return (
    <Dialog
      portal
      title={uiText('workspace:exportTitle')}
      subtitle={uiText('workspace:exportDescription')}
      onClose={() => {
        jobRef.current?.close();
        onClose();
      }}
    >
      {busy && <p role="status">{uiText('workspace:exportPreparing')}</p>}
      {data && <p>{uiText('workspace:exportCount', { count: data.messageCount })}</p>}
      {error && <p role="alert">{error}</p>}
      {copied && <p role="status">{uiText('workspace:exportCopied')}</p>}
      <div className="dialog-actions conversation-export-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            jobRef.current?.close();
            onClose();
          }}
        >
          {uiText('workspace:exportClose')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !data}
          onClick={() => void deliver(true)}
        >
          <Copy size={15} />
          {uiText('workspace:exportCopy')}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !data}
          onClick={() => void deliver(false)}
        >
          <Download size={15} />
          {uiText('workspace:exportDownload')}
        </button>
      </div>
    </Dialog>
  );
}

import { useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import type { WorkspaceSummary } from '../../../../shared/platform';
import { Dialog } from '../../components/UI';
import { platformApi } from '../platformApi';
import { uiText } from '../../i18n';

export function TeamCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (workspace: WorkspaceSummary) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  return (
    <Dialog
      title={uiText('account:text_4ce7ada52267')}
      subtitle={uiText('account:text_16083ba8966c')}
      onClose={() => {
        if (!running.current) onClose();
      }}
      className="platform-dialog"
    >
      <form
        className="dialog-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (running.current) return;
          running.current = true;
          setBusy(true);
          setError('');
          try {
            const workspace = await platformApi<WorkspaceSummary>('/account/workspaces', 'POST', {
              name: name.trim(),
            });
            onCreated(workspace);
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            running.current = false;
            setBusy(false);
          }
        }}
      >
        <label>
          {uiText('account:text_492fd0457fc4')}
          <input
            required
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            placeholder={uiText('account:text_e96f04f04be0')}
            autoComplete="organization"
          />
        </label>
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
            {uiText('account:text_2cd0f3be8738')}
          </button>
          <button className="primary-button" disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
            {uiText('account:text_d2ec1c315266')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

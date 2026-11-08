import { uiText } from '../i18n';
import { BookOpen, Info, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BotAgent, Memory } from '../../../shared/types';
import { createFormSubmission, type FormSaveResult } from '../formSubmission';
import { Dialog, IconButton } from './UI';

export function MemoryDialog({
  agents,
  memories,
  busy,
  onClose,
  onAdd,
  onDelete,
  onEdit,
}: {
  agents: BotAgent[];
  memories: Memory[];
  busy: boolean;
  onClose: () => void;
  onAdd: (body: unknown) => Promise<FormSaveResult>;
  onDelete: (id: string) => Promise<void>;
  onEdit: (id: string, content: string) => Promise<FormSaveResult>;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id || ''),
    [content, setContent] = useState(''),
    [category, setCategory] = useState('preference'),
    [editId, setEditId] = useState(''),
    [editText, setEditText] = useState('');
  const [submission] = useState(createFormSubmission);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ target: string; message: string } | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const locked = busy || saving;
  useEffect(() => {
    if (saveError) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [saveError]);
  async function save(target: string, work: () => Promise<FormSaveResult>, saved: () => void) {
    if (busy || submission.pending) return;
    setSaving(true);
    setSaveError(null);
    const result = await submission.submit(work, saved);
    if (result && !result.ok) setSaveError({ target, message: result.error });
    setSaving(false);
  }
  return (
    <Dialog
      title={uiText('common:text_b80e99482ac0')}
      subtitle={uiText('common:text_455d95b21acd')}
      onClose={onClose}
    >
      <div className="memory-list">
        {memories.length === 0 ? (
          <div className="modal-empty">
            <BookOpen size={28} />
            <p>{uiText('common:text_12cb6517b8e4')}</p>
            <span>{uiText('common:text_c0841e61b3f7')}</span>
          </div>
        ) : (
          memories.map((m) => (
            <div className="editable-memory" key={m.id}>
              <div>
                <span className="memory-category">
                  {
                    {
                      preference: uiText('common:text_0917dd72008a'),
                      context: uiText('common:text_7919fb3047b0'),
                      learning: uiText('common:text_60dc85300aa5'),
                    }[m.category]
                  }
                </span>
                <small>{agents.find((a) => a.id === m.agentId)?.name}</small>
              </div>
              {editId === m.id ? (
                <>
                  <textarea
                    aria-label={uiText('common:text_cbed9e7f2421')}
                    aria-describedby={
                      saveError?.target === m.id ? `memory-${m.id}-save-error` : undefined
                    }
                    disabled={locked}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                  />
                  {saveError?.target === m.id && (
                    <div
                      className="inline-save-error"
                      id={`memory-${m.id}-save-error`}
                      role="alert"
                      tabIndex={-1}
                      ref={errorRef}
                    >
                      <Info size={15} />
                      <span>
                        {saveError.message}
                        {uiText('common:text_25d950131dc1')}
                      </span>
                    </div>
                  )}
                  <div className="inline-actions">
                    <button
                      className="text-button"
                      disabled={locked}
                      onClick={() => {
                        setEditId('');
                        setSaveError(null);
                      }}
                    >
                      {uiText('common:text_2cd0f3be8738')}
                    </button>
                    <button
                      className="text-button"
                      disabled={locked || !editText.trim()}
                      onClick={() =>
                        void save(
                          m.id,
                          () => onEdit(m.id, editText),
                          () => setEditId(''),
                        )
                      }
                    >
                      {saving
                        ? uiText('common:text_6bdb4435095e')
                        : uiText('common:text_a3030bf8f16d')}
                    </button>
                  </div>
                </>
              ) : (
                <p>{m.content}</p>
              )}
              <div className="memory-actions">
                <button
                  className="text-button"
                  disabled={locked}
                  onClick={() => {
                    setEditId(m.id);
                    setEditText(m.content);
                    setSaveError(null);
                  }}
                >
                  {uiText('common:text_051836569928')}
                </button>
                <IconButton
                  label={uiText('common:text_34b094b2e640')}
                  disabled={locked}
                  onClick={() => void onDelete(m.id)}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            </div>
          ))
        )}
      </div>
      <form
        className="dialog-form bordered-form"
        aria-busy={saving}
        onSubmit={(e) => {
          e.preventDefault();
          if (!content.trim() || !agents.some((agent) => agent.id === agentId)) return;
          void save(
            'new',
            () => onAdd({ agentId, content, category }),
            () => setContent(''),
          );
        }}
      >
        <div className="field-pair">
          <label>
            {uiText('common:text_f37280c26275')}
            <select disabled={locked} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {uiText('common:text_0d12cbd6562b')}
            <select
              disabled={locked}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="preference">{uiText('common:text_0917dd72008a')}</option>
              <option value="context">{uiText('common:text_7919fb3047b0')}</option>
              <option value="learning">{uiText('common:text_60dc85300aa5')}</option>
            </select>
          </label>
        </div>
        <label>
          {uiText('common:text_876d5da8affa')}
          <textarea
            required
            rows={2}
            disabled={locked}
            aria-describedby={saveError?.target === 'new' ? 'memory-create-error' : undefined}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={uiText('common:text_93fbe7766ce7')}
          />
        </label>
        {saveError?.target === 'new' && (
          <div
            className="inline-save-error"
            id="memory-create-error"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            <Info size={15} />
            <span>
              {saveError.message}
              {uiText('common:text_94df5264df0b')}
            </span>
          </div>
        )}
        <div className="dialog-actions">
          <button
            className="primary-button"
            disabled={locked || !content.trim() || !agents.some((agent) => agent.id === agentId)}
          >
            <Plus size={15} />
            {saving ? uiText('common:text_6bdb4435095e') : uiText('common:text_f4fdd80a74f4')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

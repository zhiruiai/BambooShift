import { currentLanguage } from '../i18n';
import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Copy, Loader2, RefreshCw, ArrowRight } from 'lucide-react';
import {
  MEMORY_IMPORT_MAX_CHARS,
  type MemoryImportReadiness,
  type MemoryImportReceipt,
} from '../../../shared/memory-imports';
import {
  createMemoryImportClient,
  memoryImportProblem,
  memoryImportStatus,
  memoryImportFinished,
  type MemoryImportActivity,
  type MemoryImportClientState,
} from '../memoryImport';
import './MemoryImportPanel.css';

export type MemoryImportPanelProps = {
  workspaceId?: string;
  userId?: string;
  active?: boolean;
  personalHref?: string;
  onConfigurePrimary: () => void;
  onConfigureModel: () => void;
  onActivity?: (activity: MemoryImportActivity) => void;
  onImported: (receipt: MemoryImportReceipt) => void | Promise<void>;
};
export function MemoryImportPanel(props: MemoryImportPanelProps) {
  return <MemoryImportContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function MemoryImportContent(props: MemoryImportPanelProps) {
  const latest = useRef(props);
  latest.current = props;
  const [content, setContent] = useState(''),
    [readiness, setReadiness] = useState<MemoryImportReadiness>();
  const [state, setState] = useState<MemoryImportClientState>({
    busy: false,
    error: '',
    canRetry: false,
    originalAvailable: false,
  });
  const [loading, setLoading] = useState(true),
    [opening, setOpening] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const value = useRef(content);
  value.current = content;
  const activity = useRef<MemoryImportActivity>({ dirty: false, busy: false, pending: false }),
    readOrder = useRef(0),
    openingRef = useRef(false),
    prompt = useRef<HTMLTextAreaElement>(null);
  function report(patch: Partial<MemoryImportActivity>) {
    activity.current = { ...activity.current, ...patch };
    latest.current.onActivity?.({ ...activity.current });
  }
  const [client] = useState(() =>
    createMemoryImportClient({
      ...props,
      identity: () => latest.current,
      enabled: () => latest.current.active !== false,
      onState(next) {
        setState(next);
        report({ busy: next.busy || openingRef.current, pending: !!next.request && !next.receipt });
      },
    }),
  );
  const current = () =>
    client.scope.current(client.scope.ticket()) && latest.current.active !== false;
  async function read() {
    const ticket = client.scope.ticket(),
      order = ++readOrder.current;
    if (!current()) return;
    setLoading(true);
    setError('');
    try {
      const next = await client.scope.request<MemoryImportReadiness>('/memory-imports');
      if (
        client.scope.current(ticket) &&
        latest.current.active !== false &&
        order === readOrder.current
      )
        setReadiness(next);
    } catch (cause) {
      if (client.scope.current(ticket) && order === readOrder.current)
        setError((cause as Error).message);
    } finally {
      if (client.scope.current(ticket) && order === readOrder.current) setLoading(false);
    }
  }
  useEffect(() => {
    client.resume();
    return () => {
      readOrder.current++;
      client.suspend();
      latest.current.onActivity?.({ dirty: false, busy: false, pending: false });
    };
  }, [client]);
  useEffect(() => {
    if (props.active !== false) {
      void read();
      if (client.state().request) void client.check();
    } else readOrder.current++;
  }, [client, props.active]);
  async function copy() {
    const ticket = client.scope.ticket();
    if (!current()) return;
    try {
      await navigator.clipboard.writeText(uiText('settings:memoryExportPrompt'));
      if (client.scope.current(ticket) && current()) setNotice(uiText('common:text_dfadcf34c980'));
    } catch {
      if (client.scope.current(ticket) && current()) {
        prompt.current?.focus();
        prompt.current?.select();
        setNotice(uiText('common:text_229ebb5e46a8'));
      }
    }
  }
  async function open(receipt: MemoryImportReceipt) {
    if (!current() || openingRef.current || receipt.status === 'missing') return;
    const ticket = client.scope.ticket();
    openingRef.current = true;
    setOpening(true);
    report({ busy: true });
    setError('');
    try {
      await latest.current.onImported(receipt);
      client.acknowledged();
      if (client.scope.current(ticket)) {
        setContent('');
        value.current = '';
        report({ dirty: false });
      }
    } catch (cause) {
      if (client.scope.current(ticket)) setError((cause as Error).message);
    } finally {
      openingRef.current = false;
      if (client.scope.current(ticket)) {
        setOpening(false);
        report({ busy: client.state().busy });
      }
    }
  }
  async function submit(retry = false) {
    if (!current() || openingRef.current) return;
    setError('');
    setNotice('');
    const issue = !retry && memoryImportProblem(value.current);
    if (issue) {
      setError(issue);
      return;
    }
    if (
      !retry &&
      (!readiness?.available || !readiness.primary.agentId || !readiness.primary.conversationId)
    ) {
      setError(uiText('common:text_75d45752c1b7'));
      return;
    }
    const receipt = retry
      ? await client.retry()
      : await client.start(value.current, readiness!.primary.revision);
    if (receipt && current()) {
      report({ dirty: false });
      await open(receipt);
    }
  }
  const locked =
    state.busy || opening || !!state.request || !!state.blocked || props.active === false;
  const personalRequired = readiness?.reason === 'personal_required';
  return (
    <section className="memory-import-panel" aria-label={uiText('common:text_6313d49468e9')}>
      <h3>{uiText('common:text_755b9e320d75')}</h3>
      <p className="field-help">{uiText('common:text_b093adfcf57a')}</p>
      {!readiness ? (
        <p className="field-help">
          {loading ? uiText('common:text_3cbe4286d24c') : uiText('common:text_ec41de34378b')}
        </p>
      ) : personalRequired ? (
        <div className="memory-import-notice">
          <p>{uiText('common:text_771d40b7c412')}</p>
          {props.personalHref && (
            <a className="secondary-button" href={props.personalHref}>
              {uiText('common:text_a88158b8268a')}
            </a>
          )}
        </div>
      ) : (
        <>
          <label>
            {uiText('common:text_539d3b4fd3f9')}
            <textarea
              ref={prompt}
              readOnly
              rows={5}
              value={uiText('settings:memoryExportPrompt')}
              aria-label={uiText('common:text_2e92b1e3da15')}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void copy()}
            disabled={props.active === false}
          >
            <Copy size={14} />
            {uiText('common:text_3ed2c259da32')}
          </button>
          <label>
            {uiText('common:text_b26d7768ec9e')}
            <textarea
              rows={8}
              maxLength={MEMORY_IMPORT_MAX_CHARS}
              aria-label={uiText('common:text_d2cb73fbc8be')}
              value={content}
              disabled={locked}
              placeholder={uiText('common:text_8ea1bb4874f1')}
              onChange={(event) => {
                if (
                  !current() ||
                  client.state().busy ||
                  client.state().request ||
                  openingRef.current
                )
                  return;
                value.current = event.target.value;
                setContent(event.target.value);
                report({ dirty: !!event.target.value });
                setNotice('');
              }}
            />
          </label>
          <small className="memory-import-count">
            {content.length.toLocaleString(currentLanguage())} /{' '}
            {MEMORY_IMPORT_MAX_CHARS.toLocaleString(currentLanguage())}
          </small>
          {!state.request && readiness && !readiness.available && (
            <div className="memory-import-notice">
              <p>
                {readiness.reason === 'model_required'
                  ? uiText('common:text_4e68e0a16369')
                  : uiText('common:text_273e5a7fff12')}
              </p>
              <button
                type="button"
                className="secondary-button"
                disabled={state.busy || opening}
                onClick={() => {
                  if (!current() || client.state().busy || openingRef.current) return;
                  readiness.reason === 'model_required'
                    ? latest.current.onConfigureModel()
                    : latest.current.onConfigurePrimary();
                }}
              >
                {readiness.reason === 'model_required'
                  ? uiText('common:text_c1985760bffe')
                  : uiText('common:text_31454c9908e3')}
                <ArrowRight size={14} />
              </button>
            </div>
          )}
          {!state.request && (
            <button
              type="button"
              className="primary-button"
              disabled={locked || loading || !readiness?.available || !content.trim()}
              onClick={() => void submit()}
            >
              {state.busy ? <Loader2 size={14} className="spin" /> : null}
              {uiText('common:text_46e42919a795')}
            </button>
          )}
        </>
      )}
      {(error || state.error) && (
        <p role="alert" className="error-text">
          {error || state.error}
        </p>
      )}
      {notice && (
        <p role="status" className="field-help">
          {notice}
        </p>
      )}
      {state.request && !state.receipt && (
        <div className="memory-import-notice">
          <p>
            {state.busy ? uiText('common:text_637a207e72b8') : uiText('common:text_305d2bbf3e53')}
          </p>
          {!state.originalAvailable && <p>{uiText('common:text_a953d244d9d6')}</p>}
          <button
            type="button"
            className="secondary-button"
            disabled={state.busy || opening}
            onClick={() => void client.check()}
          >
            <RefreshCw size={14} />
            {uiText('common:text_cbc7c8709186')}
          </button>
          {state.canRetry && (
            <button
              type="button"
              className="secondary-button"
              disabled={state.busy || opening}
              onClick={() => void submit(true)}
            >
              {uiText('common:text_8d7d39d122a6')}
            </button>
          )}
        </div>
      )}
      {state.receipt && (
        <div className="memory-import-notice" role="status">
          <p>{memoryImportStatus(state.receipt.status)}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={state.busy || opening}
            onClick={() => void client.check()}
          >
            <RefreshCw size={14} />
            {uiText('common:text_bb70cd5eb042')}
          </button>
          {state.receipt.status !== 'missing' && (
            <button
              type="button"
              className="primary-button"
              disabled={state.busy || opening}
              onClick={() => void open(state.receipt!)}
            >
              {opening ? <Loader2 size={14} className="spin" /> : null}
              {uiText('common:text_bf3ce36fb2d5')}
              <ArrowRight size={14} />
            </button>
          )}
          {memoryImportFinished(state.receipt) && (
            <>
              <p className="field-help">{uiText('common:text_670382bbbdb4')}</p>
              <button
                type="button"
                className="secondary-button"
                disabled={state.busy || opening}
                onClick={() => {
                  if (!current() || openingRef.current || !client.finish()) return;
                  setContent('');
                  value.current = '';
                  setError('');
                  setNotice('');
                  report({ dirty: false });
                }}
              >
                {uiText('common:text_81ba81766347')}
              </button>
            </>
          )}
        </div>
      )}
      {!state.request && (
        <button
          type="button"
          className="text-button"
          disabled={loading || state.busy || opening}
          onClick={() => void read()}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          {uiText('common:text_1953f84e3a4e')}
        </button>
      )}
    </section>
  );
}

import { serviceText } from '../i18n/serviceText';
import { currentLanguage } from '../i18n';
import { uiText, localizedData } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Cloud, Info, Loader2, Play, RefreshCw } from 'lucide-react';
import type { CloudComputerState } from '../../../shared/cloud-computer';
import { useAccount } from '../AccountContext';
import { useFixedWorkspaceApi } from '../useFixedWorkspaceApi';
import './CloudComputerCard.css';

const statusLabels: Record<CloudComputerState['state'], string> = localizedData(() => ({
  unconfigured: uiText('computer:text_80a57e03f071'),
  running: uiText('computer:text_1f0eb99b7ed0'),
  paused: uiText('computer:text_eb0c326b60ae'),
  pausing: uiText('computer:text_7c78a6c31980'),
  unknown: uiText('computer:text_12532dbccf5f'),
}));
function dateLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return uiText('computer:text_a8ba58908a10');
  return new Date(value).toLocaleString(currentLanguage(), { hour12: false });
}

export function CloudComputerCard({
  disabled = false,
  visible = true,
  onPendingChange,
  onStateChange,
  onPrepareStart,
  onStarted,
}: {
  disabled?: boolean;
  visible?: boolean;
  onPendingChange: (pending: boolean) => void;
  onStateChange: (state: CloudComputerState) => void;
  onPrepareStart?: () => Promise<void>;
  onStarted: (state: CloudComputerState) => Promise<void>;
}) {
  const account = useAccount();
  const { api, current: currentIdentity } = useFixedWorkspaceApi();
  const enabled = !!account;
  const owner = account?.workspace.role === 'owner';
  const [state, setState] = useState<CloudComputerState | null>(null);
  const [loading, setLoading] = useState(true),
    [starting, setStarting] = useState(false),
    [readError, setReadError] = useState(''),
    [actionError, setActionError] = useState('');
  const mounted = useRef(true),
    request = useRef(0),
    startPending = useRef(false),
    readPending = useRef(false);

  async function readState(afterFailedStart = false) {
    if (
      !enabled ||
      !mounted.current ||
      !currentIdentity() ||
      readPending.current ||
      (startPending.current && !afterFailedStart)
    )
      return;
    readPending.current = true;
    const current = ++request.current;
    setLoading(true);
    try {
      const next = await api<CloudComputerState>('/cloud-computer');
      if (currentIdentity() && mounted.current && current === request.current) {
        setState(next);
        onStateChange(next);
        setReadError('');
      }
    } catch (cause) {
      if (currentIdentity() && mounted.current && current === request.current)
        setReadError((cause as Error).message);
    } finally {
      readPending.current = false;
      if (currentIdentity() && mounted.current && current === request.current) setLoading(false);
    }
  }
  const readLatest = useRef(readState);
  readLatest.current = readState;
  useEffect(() => {
    mounted.current = enabled;
    return () => {
      mounted.current = false;
    };
  }, [enabled]);
  useEffect(() => {
    const readVisible = () => {
      if (enabled && !document.hidden) void readLatest.current();
    };
    readVisible();
    if (!visible) return;
    const timer = setInterval(readVisible, 30000);
    window.addEventListener('focus', readVisible);
    document.addEventListener('visibilitychange', readVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', readVisible);
      document.removeEventListener('visibilitychange', readVisible);
    };
  }, [enabled, visible]);

  async function start() {
    if (
      !owner ||
      !state?.canStart ||
      disabled ||
      startPending.current ||
      readPending.current ||
      loading
    )
      return;
    startPending.current = true;
    request.current++;
    setStarting(true);
    setActionError('');
    onPendingChange(true);
    let submitted = false,
      completed = false;
    try {
      await onPrepareStart?.();
      if (!mounted.current || !currentIdentity()) return;
      submitted = true;
      const next = await api<CloudComputerState>('/cloud-computer/start', 'POST', {});
      completed = true;
      if (!mounted.current || !currentIdentity()) return;
      setState(next);
      onStateChange(next);
      setReadError('');
      await onStarted(next);
    } catch (cause) {
      if (!mounted.current || !currentIdentity()) return;
      setActionError(
        completed
          ? uiText('computer:text_c1623fbf6d3b', { value0: (cause as Error).message })
          : (cause as Error).message,
      );
      // A failed start may have partially restored the computer. Only read its
      // resulting state; never retry a write without another explicit click.
      if (submitted) await readState(true);
    } finally {
      startPending.current = false;
      if (currentIdentity() && mounted.current) {
        setStarting(false);
      }
      if (currentIdentity()) onPendingChange(false);
    }
  }

  if (!visible || !enabled || state?.configured === false) return null;
  if (!state && loading) return <p role="status">{uiText('computer:location_cloud_loading')}</p>;
  const error = actionError || readError || state?.error?.message;
  const label = state ? statusLabels[state.state] : uiText('computer:text_12532dbccf5f');
  const operating = starting || !!state?.operation;
  return (
    <section className="cloud-computer-card" aria-label={uiText('computer:text_5baf2d366da1')}>
      <div className="cloud-computer-heading">
        <div className="cloud-computer-identity">
          <Cloud size={19} aria-hidden="true" />
          <div>
            <h3>{state?.name || uiText('computer:text_ad7092f92b51')}</h3>
            <span className={`cloud-computer-status state-${state?.state || 'unknown'}`}>
              {operating && <Loader2 size={12} className="spin" aria-hidden="true" />}
              {operating ? uiText('computer:text_aadfc5c07671') : label}
            </span>
          </div>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={loading || starting}
          onClick={() => void readState()}
          aria-label={uiText('computer:text_3f06c918588c')}
        >
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          {uiText('computer:text_aee887434131')}
        </button>
      </div>
      {state && (
        <dl className="cloud-computer-facts">
          <div>
            <dt>{uiText('computer:text_9ca4b75d0326')}</dt>
            <dd>{dateLabel(state.expiresAt)}</dd>
          </div>
          <div>
            <dt>{uiText('computer:text_8089084e6ebc')}</dt>
            <dd>
              {state.worker.connected
                ? uiText('computer:text_5be0323e8adc')
                : state.worker.reconnectRequired
                  ? uiText('computer:text_2a7573e8891b')
                  : uiText('computer:text_93ae902da0d3')}
            </dd>
          </div>
        </dl>
      )}
      {state?.notice && <p className="cloud-computer-notice">{serviceText(state.notice)}</p>}
      {owner && state && !state.canStart && !operating && state.state !== 'unknown' && (
        <p className="cloud-computer-notice">{uiText('computer:text_0bdb3a9a0538')}</p>
      )}
      {error && (
        <p className="cloud-computer-error" role="alert">
          <Info size={14} />
          <span>{serviceText(error)}</span>
        </p>
      )}
      <div className="cloud-computer-footer">
        <p>
          {owner ? uiText('computer:text_55dab53322ab') : uiText('computer:text_2d4ee8c6b0ce')}
          {state && (
            <small>
              {uiText('computer:text_037de8ddb28e')}
              {dateLabel(state.observedAt)}
            </small>
          )}
        </p>
        {owner && state && (
          <button
            className="secondary-button"
            type="button"
            disabled={disabled || loading || operating || !state.canStart}
            onClick={() => void start()}
          >
            {starting ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {starting
              ? uiText('computer:text_3bc2ef921947')
              : state.state === 'running'
                ? uiText('computer:text_f490405b94f5')
                : state.state === 'paused'
                  ? uiText('computer:text_1a0d2f31fe86')
                  : uiText('computer:text_9bad68e890de')}
          </button>
        )}
      </div>
    </section>
  );
}

import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { RoutineRun } from '../../../shared/routine-runs';
import { routineRunLabel, routineRunTime, useRoutineRuns } from '../routineRuns';
import './RoutineDialog.css';

export function RoutineRunHistory(props: {
  routineId: string;
  timeZone?: string;
  workspaceId?: string;
  userId?: string;
  refreshKey?: string;
  disabled?: boolean;
  onOpenRun?: (run: RoutineRun) => void | Promise<void>;
}) {
  const history = useRoutineRuns(props),
    latest = useRef(props),
    active = useRef(true),
    openingRef = useRef(false);
  latest.current = props;
  const [opening, setOpening] = useState<string>(),
    [error, setError] = useState('');
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function open(original: RoutineRun) {
    const runId = original.runId;
    const ticket = history.scope.ticket();
    if (
      !active.current ||
      !history.scope.current(ticket) ||
      openingRef.current ||
      latest.current.disabled ||
      !latest.current.onOpenRun
    )
      return;
    openingRef.current = true;
    setOpening(runId);
    setError('');
    try {
      const run = await history.get(runId);
      if (!run || !active.current || !history.scope.current(ticket) || latest.current.disabled)
        return;
      if (original.resultMessageId && !run.resultMessageId)
        throw Error(uiText('routines:text_737309e09728'));
      if (!run.resultMessageId && !run.inputMessageId)
        throw Error(uiText('routines:text_46413fefd8fe'));
      await latest.current.onOpenRun!(run);
    } catch (cause) {
      if (active.current && history.scope.current(ticket))
        setError((cause as Error).message || uiText('routines:text_1b220093719b'));
    } finally {
      openingRef.current = false;
      if (active.current && history.scope.current(ticket)) setOpening(undefined);
    }
  }
  return (
    <section className="routine-run-history" aria-label={uiText('routines:text_15a85ddda040')}>
      <div className="routine-history-heading">
        <h4>{uiText('routines:text_15a85ddda040')}</h4>
        <button
          type="button"
          className="secondary-button"
          disabled={history.state.loading || !!opening || props.disabled}
          onClick={() => void history.read()}
        >
          <RefreshCw size={14} />
          {uiText('routines:text_621e17c543bc')}
        </button>
      </div>
      <p className="field-help">{uiText('routines:text_ff686ebd7ea3')}</p>
      {(history.state.error || error) && (
        <p className="error-text" role="alert">
          {error || history.state.error}
          {history.state.error && history.state.loaded ? uiText('routines:text_0a57e311f900') : ''}
        </p>
      )}
      {!history.state.loaded && history.state.loading && (
        <p className="field-help">
          <Loader2 size={14} className="spin" />
          {uiText('routines:text_928a5e24af4d')}
        </p>
      )}
      {history.state.loaded && !history.state.error && history.state.runs.length === 0 && (
        <p className="routine-history-empty">{uiText('routines:text_df59295adf73')}</p>
      )}
      {history.state.runs.length > 0 && (
        <ol className="routine-history-list">
          {history.state.runs.map((run) => (
            <li key={run.runId}>
              <div className="routine-history-row">
                <strong data-status={run.status}>{routineRunLabel(run.status)}</strong>
                <span>
                  {run.trigger === 'manual'
                    ? uiText('routines:text_9f4a53360d91')
                    : run.trigger === 'webhook'
                      ? uiText('routines:webhookTrigger')
                      : uiText('routines:text_43148cd3a626')}
                </span>
                {(run.resultMessageId || run.inputMessageId) && props.onOpenRun && (
                  <button
                    type="button"
                    className="routine-chat-link"
                    disabled={!!opening || props.disabled}
                    onClick={() => void open(run)}
                  >
                    {opening === run.runId
                      ? uiText('routines:text_821ffb8cd6a2')
                      : run.resultMessageId
                        ? uiText('routines:text_d06bc6efdd8c')
                        : run.status === 'running'
                          ? uiText('routines:text_1e9603e7ce91')
                          : uiText('routines:text_24d5c1595daa')}
                  </button>
                )}
              </div>
              <time dateTime={run.startedAt}>
                {uiText('routines:text_4c50a8af41b2')}
                {routineRunTime(run.startedAt, props.timeZone)}
              </time>
              {run.finishedAt && (
                <time dateTime={run.finishedAt}>
                  {uiText('routines:text_6ee96f2b5962')}
                  {routineRunTime(run.finishedAt, props.timeZone)}
                </time>
              )}
              {run.error && <p className="routine-run-reason">{serviceText(run.error)}</p>}
              {!run.resultMessageId && run.status !== 'running' && (
                <p className="field-help">{uiText('routines:text_b884552b34ae')}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

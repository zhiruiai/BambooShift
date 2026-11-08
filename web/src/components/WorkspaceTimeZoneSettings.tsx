import { displayTimeZone } from '../timeZones';
import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type {
  WorkspaceTimeZoneState,
  UpdateWorkspaceTimeZone,
} from '../../../shared/workspace-time-zone';
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from '../../../shared/time-zone';
import { createPrimaryBotScope } from '../primaryBot';
import { TimeZoneSelect } from './TimeZoneSelect';
import './TimeZoneSettings.css';

type Activity = { dirty: boolean; busy: boolean; pending: boolean };
type Props = {
  workspaceId?: string;
  userId?: string;
  canManage: boolean;
  active?: boolean;
  initialState?: WorkspaceTimeZoneState;
  onActivity?: (activity: Activity) => void;
  onSaved: (state: WorkspaceTimeZoneState) => void;
};
type Form = {
  base?: WorkspaceTimeZoneState;
  draft: string;
  loading: boolean;
  busy: boolean;
  pending: boolean;
  error: string;
  notice: string;
  attempt?: UpdateWorkspaceTimeZone;
  observed?: WorkspaceTimeZoneState;
};
function checked(value: WorkspaceTimeZoneState) {
  if (!value || typeof value.revision !== 'string' || !value.revision.length)
    throw Error(uiText('settings:text_46bc10a40ff1'));
  return { ...value, timeZone: normalizeTimeZone(value.timeZone) };
}
export function WorkspaceTimeZoneSettings(props: Props) {
  return <WorkspaceTimeZoneContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function WorkspaceTimeZoneContent(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createPrimaryBotScope({ ...props, identity: () => latest.current }),
  );
  const [state, setState] = useState<Form>({
    base: props.initialState,
    draft: props.initialState?.timeZone || DEFAULT_TIME_ZONE,
    loading: true,
    busy: false,
    pending: false,
    error: '',
    notice: '',
  });
  const form = useRef(state),
    order = useRef(0);
  const current = () => scope.current(scope.ticket());
  const interactive = () => current() && latest.current.active !== false;
  const dirty = (value: Form) => !!value.base && value.draft !== value.base.timeZone;
  function publish(patch: Partial<Form>) {
    if (!current()) return;
    const next = { ...form.current, ...patch };
    form.current = next;
    setState(next);
    latest.current.onActivity?.({ dirty: dirty(next), busy: next.busy, pending: next.pending });
  }
  function accept(value: WorkspaceTimeZoneState, notice = '') {
    publish({
      base: value,
      draft: value.timeZone,
      loading: false,
      busy: false,
      pending: false,
      attempt: undefined,
      observed: undefined,
      error: '',
      notice,
    });
  }
  async function read(initial = false) {
    if (!interactive() || form.current.busy) return;
    const ticket = scope.ticket(),
      sequence = ++order.current;
    publish({ ...(initial ? { loading: true } : { busy: true }), error: '' });
    try {
      const value = checked(await scope.request<WorkspaceTimeZoneState>('/workspace-time-zone'));
      if (!scope.current(ticket) || sequence !== order.current) return;
      const before = form.current;
      if (before.attempt && value.timeZone === before.attempt.timeZone) {
        accept(value, uiText('settings:text_d6655d14a6c0'));
        latest.current.onSaved(value);
      } else if (!dirty(before) && !before.pending) accept(value);
      else
        publish({
          observed: value,
          pending: true,
          notice:
            value.revision === before.attempt?.expectedRevision
              ? uiText('settings:text_e6dbcfafaaf3')
              : uiText('settings:text_00cd75144de0'),
        });
    } catch (cause) {
      if (scope.current(ticket) && sequence === order.current)
        publish({ error: (cause as Error).message });
    } finally {
      if (scope.current(ticket) && sequence === order.current)
        publish({ busy: false, loading: false });
    }
  }
  useEffect(() => {
    scope.resume();
    return () => {
      order.current++;
      scope.suspend();
      latest.current.onActivity?.({ dirty: false, busy: false, pending: false });
    };
  }, [scope]);
  useEffect(() => {
    if (props.active !== false && form.current.loading) void read(true);
  }, [scope, props.active]);
  useEffect(() => {
    if (
      !props.initialState ||
      form.current.loading ||
      form.current.busy ||
      form.current.pending ||
      dirty(form.current)
    )
      return;
    if (props.initialState.revision !== form.current.base?.revision)
      accept(checked(props.initialState));
  }, [props.initialState?.revision, props.initialState?.timeZone]);

  async function save(retry = false) {
    const before = form.current;
    if (
      !interactive() ||
      !latest.current.canManage ||
      before.loading ||
      before.busy ||
      !before.base ||
      (!retry && before.pending)
    )
      return;
    let body: UpdateWorkspaceTimeZone;
    try {
      if (retry) {
        if (!before.attempt || before.observed?.revision !== before.attempt.expectedRevision)
          return;
        body = before.attempt;
      } else
        body = {
          expectedRevision: before.base.revision,
          timeZone: normalizeTimeZone(before.draft),
        };
    } catch (cause) {
      publish({ error: (cause as Error).message });
      return;
    }
    const ticket = scope.ticket(),
      sequence = ++order.current;
    publish({
      busy: true,
      pending: true,
      attempt: body,
      error: '',
      notice: '',
      observed: undefined,
    });
    try {
      const value = checked(
        await scope.request<WorkspaceTimeZoneState>('/workspace-time-zone', 'PUT', body),
      );
      if (!scope.current(ticket) || sequence !== order.current) return;
      if (value.timeZone !== body.timeZone) throw Error(uiText('settings:text_973ee92bd839'));
      accept(value, uiText('settings:text_a4288b743dbd'));
      latest.current.onSaved(value);
    } catch (cause) {
      if (scope.current(ticket) && sequence === order.current)
        publish({
          error: (cause as Error).message,
          notice: uiText('settings:text_953692983a6d'),
        });
    } finally {
      if (scope.current(ticket) && sequence === order.current) publish({ busy: false });
    }
  }
  const canRebase =
    !!state.observed &&
    (!state.attempt || state.observed.revision !== state.attempt.expectedRevision);
  const disabled =
    props.active === false || !state.base || state.loading || state.busy || state.pending;
  return (
    <section className="time-zone-settings" aria-label={uiText('settings:text_bceaeb58c9e2')}>
      <h3>{uiText('settings:text_bceaeb58c9e2')}</h3>
      {props.canManage ? (
        <TimeZoneSelect
          label={uiText('settings:text_97bd9514ad23')}
          value={state.draft}
          disabled={disabled}
          onChange={(draft) => {
            if (
              !interactive() ||
              !latest.current.canManage ||
              !form.current.base ||
              form.current.loading ||
              form.current.busy ||
              form.current.pending
            )
              return;
            publish({ draft, error: '', notice: '' });
          }}
        />
      ) : (
        <strong className="time-zone-readonly">{displayTimeZone(state.base?.timeZone)}</strong>
      )}
      <p className="field-help">{uiText('settings:text_6b497b82a4b8')}</p>
      {!props.canManage && <p className="field-help">{uiText('settings:text_1700c116e424')}</p>}
      {state.loading && (
        <p className="field-help" role="status">
          <Loader2 size={14} className="spin" />
          {uiText('settings:text_8326cae6358c')}
        </p>
      )}
      {state.error && (
        <p className="error-text" role="alert">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className="field-help" role="status">
          {state.notice}
        </p>
      )}
      {state.pending && state.observed && (
        <p className="field-help">
          {uiText('settings:text_4dd5034cf0f6')}
          {displayTimeZone(state.observed.timeZone)}
        </p>
      )}
      <div className="time-zone-actions">
        {props.canManage && !state.pending && (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || !dirty(state)}
            onClick={() => void save()}
          >
            {state.busy ? <Loader2 size={14} className="spin" /> : null}
            {uiText('settings:text_6c4488e262c0')}
          </button>
        )}
        {(state.error || state.pending || !state.base) && (
          <button
            type="button"
            className="secondary-button"
            disabled={state.busy || props.active === false}
            onClick={() => void read()}
          >
            <RefreshCw size={14} />
            {uiText('settings:text_562b102205a7')}
          </button>
        )}
        {props.canManage && state.pending && state.observed && (
          <>
            {canRebase ? (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={state.busy || props.active === false}
                  onClick={() => {
                    if (
                      !interactive() ||
                      !latest.current.canManage ||
                      form.current.busy ||
                      !form.current.observed ||
                      (form.current.attempt &&
                        form.current.observed.revision === form.current.attempt.expectedRevision)
                    )
                      return;
                    const value = form.current.observed;
                    accept(value);
                    latest.current.onSaved(value);
                  }}
                >
                  {uiText('settings:text_ad2b28ea0ae9')}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={state.busy || props.active === false}
                  onClick={() => {
                    const value = form.current.observed;
                    if (
                      !interactive() ||
                      !latest.current.canManage ||
                      form.current.busy ||
                      !value ||
                      (form.current.attempt &&
                        value.revision === form.current.attempt.expectedRevision)
                    )
                      return;
                    publish({
                      base: value,
                      pending: false,
                      attempt: undefined,
                      observed: undefined,
                      error: '',
                      notice: uiText('settings:text_c023df7fd15c'),
                    });
                  }}
                >
                  {uiText('settings:text_55883a8c760b')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="secondary-button"
                disabled={state.busy || props.active === false}
                onClick={() => void save(true)}
              >
                {uiText('settings:text_4e9347856a8e')}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

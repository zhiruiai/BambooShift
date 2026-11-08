import { useEffect, useRef, useState } from 'react';
import type { ConnectedApp } from '../../../../shared/app-connections';
import { createAppPolicies, policyArguments, type AppPolicyState } from '../../appPolicies';
import { uiText } from '../../i18n';
import { AppToolDetails } from '../SharedBotApps';
import './AppPolicyPanel.css';

type Props = {
  app: ConnectedApp;
  userId?: string;
  workspaceId?: string;
  canManage: boolean;
  toolAccessEpoch?: number;
  onBusy: (busy: boolean) => void;
};
export function AppPolicyPanel(props: Props) {
  return <PolicyPanel key={`${props.userId}:${props.workspaceId}:${props.app.id}`} {...props} />;
}
function PolicyPanel(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [state, setState] = useState<AppPolicyState>({
    policies: [],
    busy: false,
    loading: true,
    blocked: false,
    error: '',
  });
  const [client] = useState(() =>
    createAppPolicies({
      ...props,
      connectionId: props.app.id,
      identity: () => latest.current,
      onState: setState,
    }),
  );
  const [routineId, setRoutine] = useState(''),
    [toolName, setTool] = useState('');
  const [args, setArgs] = useState('{}'),
    [confirmation, setConfirmed] = useState(''),
    [error, setError] = useState('');
  const tool = state.options?.tools.find((item) => item.eligible && item.tool.name === toolName);
  const review = JSON.stringify([
    state.options?.connectionRevision,
    state.options?.catalogRevision,
    state.options?.routines.find((r) => r.id === routineId),
    tool,
    args,
  ]);
  const confirmed = confirmation === review;
  useEffect(() => {
    client.resume();
    return () => client.suspend();
  }, [client]);
  useEffect(() => {
    props.onBusy(state.busy);
    return () => props.onBusy(false);
  }, [state.busy, props.onBusy]);
  useEffect(() => {
    setConfirmed('');
    void client.read();
  }, [props.app.revision, props.app.status, props.toolAccessEpoch, props.canManage]);
  const disabled =
    state.busy || state.loading || state.blocked || !!state.pendingId || !props.canManage;
  if (!props.canManage || !props.userId || !props.workspaceId) return null;
  return (
    <section className="app-policy-panel">
      <h3>{uiText('workspace:appPolicies.title')}</h3>
      <p className="field-help">{uiText('workspace:appPolicies.explanation')}</p>
      {(state.error || error) && (
        <p className="error-text" role="alert">
          {state.error || error}
        </p>
      )}
      <button
        type="button"
        className="text-button"
        disabled={state.busy || state.loading}
        onClick={() => void client.read()}
      >
        {uiText('workspace:appPolicies.refresh')}
      </button>
      {state.pendingId && (
        <div className="info-box">
          <p>{uiText('workspace:appPolicies.unknown')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={state.busy || state.loading}
            onClick={() => void client.revoke(state.pendingId!)}
          >
            {uiText('workspace:appPolicies.cancelUnknown')}
          </button>
        </div>
      )}
      {state.policies.map((policy) => (
        <article className="app-policy-entry" key={policy.id}>
          <strong>
            {policy.routineTitle} · {policy.toolName}
          </strong>
          <span>{uiText(`workspace:appPolicies.status.${policy.status}`)}</span>
          <pre>{JSON.stringify(policy.arguments, null, 2)}</pre>
          {policy.status === 'active' && (
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => void client.revoke(policy.id)}
            >
              {uiText('workspace:appPolicies.revoke')}
            </button>
          )}
        </article>
      ))}
      {props.app.status === 'connected' && (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            try {
              void client.create({
                routineId,
                toolName,
                arguments: policyArguments(args),
                confirmed,
              });
            } catch {
              setError(uiText('workspace:appPolicies.argumentsInvalid'));
            }
          }}
        >
          <label>
            {uiText('workspace:appPolicies.routine')}
            <select
              value={routineId}
              disabled={disabled}
              onChange={(event) => {
                setRoutine(event.target.value);
                setConfirmed('');
              }}
            >
              <option value="">{uiText('workspace:appPolicies.chooseRoutine')}</option>
              {state.options?.routines.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
          {!state.loading && !state.options?.routines.length && (
            <p className="field-help">{uiText('workspace:appPolicies.noRoutines')}</p>
          )}
          <label>
            {uiText('workspace:appPolicies.tool')}
            <select
              value={toolName}
              disabled={disabled}
              onChange={(event) => {
                setTool(event.target.value);
                setConfirmed('');
              }}
            >
              <option value="">{uiText('workspace:appPolicies.chooseTool')}</option>
              {state.options?.tools
                .filter((t) => t.eligible)
                .map((t) => (
                  <option key={t.tool.name} value={t.tool.name}>
                    {t.tool.name}
                  </option>
                ))}
            </select>
          </label>
          {!state.loading && !state.options?.tools.some((t) => t.eligible) && (
            <p className="field-help">{uiText('workspace:appPolicies.noTools')}</p>
          )}
          {tool && <AppToolDetails tool={tool.tool} />}
          <label>
            {uiText('workspace:appPolicies.arguments')}
            <textarea
              value={args}
              rows={5}
              disabled={disabled}
              onChange={(event) => {
                setArgs(event.target.value);
                setConfirmed('');
              }}
            />
          </label>
          <p className="field-help">{uiText('workspace:appPolicies.exactScope')}</p>
          <label className="app-policy-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={disabled}
              onChange={(event) => setConfirmed(event.target.checked ? review : '')}
            />
            {uiText('workspace:appPolicies.confirm')}
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={disabled || !routineId || !tool || !confirmed}
          >
            {uiText('workspace:appPolicies.create')}
          </button>
        </form>
      )}
    </section>
  );
}

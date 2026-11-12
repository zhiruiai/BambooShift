import { uiText, localizedData } from '../i18n';
import { ChevronDown } from 'lucide-react';
import {
  REMOTE_SHELL_MAX_COMMAND,
  REMOTE_SHELL_MAX_OUTPUT_BYTES,
  REMOTE_SHELL_TIMEOUT_MS,
  type RemoteShellResult as ShellResultContract,
} from '../../../shared/isolated-shell';
import './RemoteShellDetails.css';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const resourceLimits = localizedData(
  () =>
    ({
      memory: {
        label: uiText('computer:text_00737efb967e'),
        description: uiText('computer:text_023f11f1e5e2'),
      },
      'disk-reserve': {
        label: uiText('computer:text_af4be7a81b90'),
        description: uiText('computer:text_90309c99fca0'),
      },
      pids: {
        label: uiText('computer:text_cbc151c4241f'),
        description: uiText('computer:text_11e8f8704034'),
      },
    }) satisfies Record<
      NonNullable<ShellResultContract['resourceLimit']>,
      { label: string; description: string }
    >,
);
function resourceLimitInfo(value: unknown) {
  return typeof value === 'string' && Object.hasOwn(resourceLimits, value)
    ? resourceLimits[value as keyof typeof resourceLimits]
    : undefined;
}

export function remoteShellRequestReadable(payload: Record<string, unknown>) {
  return (
    typeof payload.command === 'string' &&
    payload.command.trim().length > 0 &&
    payload.command.length <= REMOTE_SHELL_MAX_COMMAND &&
    (payload.path === undefined ||
      (typeof payload.path === 'string' && payload.path.trim().length > 0))
  );
}

export function remoteShellResultStatus(result: unknown) {
  const value = object(result);
  if (value.cancelled === true)
    return { label: uiText('computer:text_a37778f17c5f'), kind: 'cancelled' };
  if (value.timedOut === true)
    return { label: uiText('computer:text_01e46bb97093'), kind: 'error' };
  const resourceLimit = resourceLimitInfo(value.resourceLimit);
  if (resourceLimit) return { label: resourceLimit.label, kind: 'error' };
  if (typeof value.signal === 'string' && value.signal)
    return { label: uiText('computer:text_3cd1e27e45c8'), kind: 'error' };
  if (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode))
    return value.exitCode === 0
      ? { label: uiText('computer:text_f28461bb49c8'), kind: 'done' }
      : { label: uiText('computer:text_a9a91b56ff98', { value0: value.exitCode }), kind: 'error' };
  if (value.exitCode === null)
    return { label: uiText('computer:text_7949c321d1ac'), kind: 'error' };
  return undefined;
}

export function RemoteShellDetails({
  payload,
  execution = 'isolated',
}: {
  payload: Record<string, unknown>;
  execution?: 'isolated' | 'local';
}) {
  return (
    <section
      className="remote-shell-details"
      aria-label={uiText(
        execution === 'local' ? 'computer:localShellDetails' : 'computer:text_f4719ae9413b',
      )}
    >
      <span className="remote-shell-label">{uiText('computer:text_be12f84c407f')}</span>
      {typeof payload.command === 'string' && payload.command ? (
        <pre tabIndex={0} role="region" aria-label={uiText('computer:text_54c1568b500b')}>
          {payload.command}
        </pre>
      ) : null}
      {!remoteShellRequestReadable(payload) && (
        <p className="error-text">{uiText('computer:text_0875b7a2774a')}</p>
      )}
      <dl>
        <dt>{uiText('computer:text_3db7b06b5f6d')}</dt>
        <dd className="remote-shell-path">
          {payload.path === undefined
            ? uiText('computer:text_7dfe4bbbaf0a')
            : typeof payload.path === 'string'
              ? payload.path === '.'
                ? uiText('computer:text_7dfe4bbbaf0a')
                : payload.path
              : uiText('computer:text_4e9fcac3cb02')}
        </dd>
        <dt>{uiText('computer:text_d3e0d83a0d31')}</dt>
        <dd>
          {uiText('computer:text_298754d6bec8')}
          {REMOTE_SHELL_TIMEOUT_MS / 1000}
          {uiText(
            execution === 'local' ? 'computer:localShellSeconds' : 'computer:text_293eef890e19',
          )}
        </dd>
      </dl>
      <p className="remote-shell-scope">
        {uiText(execution === 'local' ? 'computer:localShellScope' : 'computer:text_3b1f916bb177')}
      </p>
    </section>
  );
}

function Output({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === 'string' ? value : '';
  return (
    <div className="remote-shell-output">
      <span className="remote-shell-label">{label}</span>
      {text ? (
        <>
          <pre tabIndex={0} role="region" aria-label={label}>
            {text.slice(0, REMOTE_SHELL_MAX_OUTPUT_BYTES)}
          </pre>
          {text.length > REMOTE_SHELL_MAX_OUTPUT_BYTES && (
            <p className="remote-shell-note">{uiText('computer:text_58318c22561d')}</p>
          )}
        </>
      ) : (
        <p className="remote-shell-note">{uiText('computer:text_6bc958f11775')}</p>
      )}
    </div>
  );
}

export function RemoteShellResult({ result }: { result: unknown }) {
  const value = object(result);
  const status = remoteShellResultStatus(value);
  const resourceLimit = resourceLimitInfo(value.resourceLimit);
  return (
    <details className="remote-shell-result">
      <summary>
        <span>
          {uiText('computer:text_db69ade95f43')}
          {status?.label || uiText('computer:text_17337902d692')}
        </span>
        <ChevronDown size={13} />
      </summary>
      <div className="remote-shell-result-body">
        <dl>
          <dt>{uiText('computer:text_0a67f363af79')}</dt>
          <dd>
            {typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)
              ? value.exitCode
              : value.exitCode === null
                ? uiText('computer:text_f0e73283f4f6')
                : uiText('computer:text_e129934bb702')}
          </dd>
          {typeof value.signal === 'string' && value.signal && (
            <>
              <dt>{uiText('computer:text_93858bb03d54')}</dt>
              <dd>{value.signal}</dd>
            </>
          )}
        </dl>
        {typeof value.durationMs === 'number' &&
          Number.isFinite(value.durationMs) &&
          value.durationMs >= 0 && (
            <p className="remote-shell-note">
              {uiText('computer:text_d3af2ee7603d')}
              {(value.durationMs / 1000).toFixed(1)}
              {uiText('computer:text_00fe8dda1fd7')}
            </p>
          )}
        {value.timedOut === true && (
          <p className="remote-shell-note">
            {uiText('computer:text_c08184a0388f')}
            {REMOTE_SHELL_TIMEOUT_MS / 1000}
            {uiText('computer:text_d32bf08125eb')}
          </p>
        )}
        {value.cancelled === true && (
          <p className="remote-shell-note">{uiText('computer:text_00772372908d')}</p>
        )}
        {resourceLimit && <p className="remote-shell-note">{resourceLimit.description}</p>}
        {value.truncated === true && (
          <p className="remote-shell-note">{uiText('computer:text_412e706a1e97')}</p>
        )}
        <Output label={uiText('computer:text_0f6170615e9c')} value={value.stdout} />
        <Output label={uiText('computer:text_ca4dd7995e2d')} value={value.stderr} />
      </div>
    </details>
  );
}

import { formatNumber, uiText } from '../i18n';
import './RemoteShellDetails.css';

const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function skillScriptRequest(payload: Record<string, unknown>) {
  const { skillName, skillVersion, path, args, manifestSha256, input } = payload;
  if (
    typeof skillName !== 'string' ||
    !skillName.trim() ||
    typeof skillVersion !== 'number' ||
    !Number.isSafeInteger(skillVersion) ||
    skillVersion < 1 ||
    typeof path !== 'string' ||
    !/^scripts\/.+\.(?:py|mjs)$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\:\p{Cc}]/u.test(path) ||
    !Array.isArray(args) ||
    args.length > 16 ||
    !args.every((arg): arg is string => typeof arg === 'string' && !arg.includes('\0')) ||
    !digest(manifestSha256)
  )
    return;
  const inputArguments = args.filter((argument) => argument === '__SKILL_INPUT__').length;
  if (input === undefined && inputArguments === 0)
    return { skillName, skillVersion, path, args, manifestSha256 };
  if (!input || typeof input !== 'object' || Array.isArray(input) || inputArguments !== 1) return;
  const { name, sha256, bytes } = input as Record<string, unknown>;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    !digest(sha256) ||
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0
  )
    return;
  return { skillName, skillVersion, path, args, manifestSha256, input: { name, sha256, bytes } };
}

export function SkillScriptDetails({
  payload,
  pending,
}: {
  payload: Record<string, unknown>;
  pending: boolean;
}) {
  const request = skillScriptRequest(payload);
  if (!request)
    return <p className="error-text">{uiText('computer:skillScriptRequestUnavailable')}</p>;
  return (
    <section className="remote-shell-details" aria-label={uiText('computer:skillScriptDetails')}>
      <dl>
        <dt>{uiText('computer:skillScriptPackage')}</dt>
        <dd>
          {request.skillName} · v{request.skillVersion}
        </dd>
        <dt>{uiText('computer:skillScriptPath')}</dt>
        <dd className="remote-shell-path">
          <code>{request.path}</code>
        </dd>
        {request.input && (
          <>
            <dt>{uiText('computer:skillScriptInput')}</dt>
            <dd className="remote-shell-path">
              {request.input.name} ·{' '}
              {uiText('computer:skillScriptInputBytes', {
                bytes: formatNumber(request.input.bytes),
              })}
            </dd>
          </>
        )}
      </dl>
      {pending && (
        <>
          {request.args.length > 0 && (
            <>
              <span className="remote-shell-label">{uiText('computer:skillScriptArguments')}</span>
              <pre tabIndex={0}>
                {request.args.map((value) => JSON.stringify(value)).join('\n')}
              </pre>
              {request.input && (
                <p className="remote-shell-note">{uiText('computer:skillScriptInputArgument')}</p>
              )}
            </>
          )}
          <p className="remote-shell-scope">{uiText('computer:skillScriptScope')}</p>
        </>
      )}
    </section>
  );
}

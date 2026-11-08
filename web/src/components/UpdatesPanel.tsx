import { ExternalLink, RefreshCw } from 'lucide-react';
import { useUpdates, type UpdateStatus } from '../updates';
import { compareUpdate } from '../updateVersions';
import { formatDate, uiText } from '../i18n';
import './UpdatesPanel.css';
const statusLabel = (status: UpdateStatus) =>
  uiText(
    (
      {
        unconfigured: 'workspace:updatesUnconfigured',
        unavailable: 'workspace:updatesUnavailable',
        current: 'workspace:updatesCurrent',
        update_available: 'workspace:updatesAvailable',
        unknownVersion: 'workspace:updatesUnknownVersion',
      } as const
    )[status],
  );
export function UpdatesPanel(props: { userId?: string; workspaceId?: string; active?: boolean }) {
  return <UpdatesContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function UpdatesContent(props: { userId?: string; workspaceId?: string; active?: boolean }) {
  const updates = useUpdates(props),
    data = updates.data;
  if (!updates.available)
    return <p className="field-help">{uiText('workspace:updatesAccountRequired')}</p>;
  return (
    <section
      className="updates-panel"
      aria-busy={updates.loading}
      aria-label={uiText('workspace:updatesTitle')}
    >
      <p className="field-help">{uiText('workspace:updatesDescription')}</p>
      <dl className="updates-versions">
        <div>
          <dt>{uiText('workspace:updatesServiceVersion')}</dt>
          <dd>{data?.serviceVersion || uiText('workspace:updatesNotRead')}</dd>
        </div>
        <div>
          <dt>{uiText('workspace:updatesWebVersion')}</dt>
          <dd>{updates.sourceVersion}</dd>
        </div>
        {updates.desktop && (
          <div>
            <dt>{uiText('workspace:updatesDesktopVersion')}</dt>
            <dd>{updates.desktopVersion || uiText('workspace:updatesNotRead')}</dd>
          </div>
        )}
      </dl>
      {updates.error && (
        <p role="alert" className="updates-error">
          {updates.error}
        </p>
      )}
      {data && (
        <>
          <p role="status">
            <strong>{statusLabel(data.status)}</strong>
          </p>
          {data.repository && (
            <p>{uiText('workspace:updatesRepository', { repository: data.repository })}</p>
          )}
          {data.status === 'unconfigured' && (
            <p className="field-help">{uiText('workspace:updatesConfigureHint')}</p>
          )}
          {data.reason && (
            <p className="field-help">
              {uiText(
                (
                  {
                    not_checked: 'workspace:updatesNotChecked',
                    network: 'workspace:updatesNetwork',
                    timeout: 'workspace:updatesTimeout',
                    rate_limited: 'workspace:updatesRateLimited',
                    not_found: 'workspace:updatesNotFound',
                    invalid_release: 'workspace:updatesInvalidRelease',
                    response_too_large: 'workspace:updatesTooLarge',
                  } as const
                )[data.reason],
              )}
            </p>
          )}
          {data.checkedAt && (
            <p className="field-help">
              {uiText('workspace:updatesLastChecked', {
                time: formatDate(data.checkedAt, { dateStyle: 'medium', timeStyle: 'short' }),
              })}
            </p>
          )}
          {data.release && (
            <div className="updates-release">
              <h3>{data.release.name || data.release.tag}</h3>
              <span>{data.release.tag}</span>
              <p>
                {uiText('workspace:updatesWebComparison', {
                  status: statusLabel(compareUpdate(updates.sourceVersion, data.release.version)),
                })}
              </p>
              {updates.desktop && (
                <p>
                  {uiText('workspace:updatesDesktopComparison', {
                    status: statusLabel(
                      compareUpdate(updates.desktopVersion, data.release.version),
                    ),
                  })}
                </p>
              )}
              {data.release.notes && (
                <details>
                  <summary>{uiText('workspace:updatesReleaseNotes')}</summary>
                  <pre>{data.release.notes}</pre>
                </details>
              )}
              <a
                className="secondary-button"
                href={data.release.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (!updates.current() || updates.desktop) event.preventDefault();
                }}
              >
                {uiText('workspace:updatesOpenRelease')}
                <ExternalLink size={14} />
              </a>
              {updates.desktop && <small>{uiText('workspace:updatesDesktopLinkHint')}</small>}
            </div>
          )}
        </>
      )}
      <div className="updates-actions">
        <button
          type="button"
          className="primary-button"
          disabled={updates.loading || props.active === false || !data?.repository}
          onClick={() => void updates.check()}
        >
          <RefreshCw size={14} />
          {uiText('workspace:updatesCheck')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={updates.loading || props.active === false}
          onClick={() => void updates.refresh()}
        >
          {uiText('workspace:updatesRefresh')}
        </button>
      </div>
      <p className="field-help">{uiText('workspace:updatesNoInstall')}</p>
    </section>
  );
}

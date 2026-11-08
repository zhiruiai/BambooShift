import { RefreshCw } from 'lucide-react';
import { formatNumber, uiText } from '../i18n';
import { useWorkspaceUsage, type UsageDays, type UsageTotals } from '../usage';
import './UsagePanel.css';

type Props = { workspaceId?: string; userId?: string; active?: boolean };
export function UsagePanel(props: Props) {
  return <UsageContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function UsageContent(props: Props) {
  const usage = useWorkspaceUsage(props);
  if (!usage.available)
    return <p className="field-help">{uiText('workspace:usageAccountRequired')}</p>;
  const data = usage.data;
  return (
    <section
      className="usage-panel"
      aria-label={uiText('workspace:usageTitle')}
      aria-busy={usage.loading}
    >
      <div className="usage-toolbar">
        <label>
          {uiText('workspace:usagePeriod')}
          <select
            value={usage.days}
            disabled={props.active === false}
            onChange={(event) => usage.changeDays(Number(event.target.value) as UsageDays)}
          >
            {([7, 30, 90] as const).map((days) => (
              <option key={days} value={days}>
                {uiText('workspace:usageDays', { days })}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={usage.loading || props.active === false}
          onClick={() => void usage.refresh()}
        >
          <RefreshCw size={14} />
          {uiText('workspace:usageRefresh')}
        </button>
      </div>
      <p className="field-help">{uiText('workspace:usageDescription')}</p>
      {usage.loading && <p role="status">{uiText('workspace:usageLoading')}</p>}
      {usage.error && (
        <p className="usage-error" role="alert">
          {usage.error}
        </p>
      )}
      {data && (
        <>
          <p className="usage-scope">
            {uiText(
              data.scope.visibility === 'workspace'
                ? 'workspace:usageWorkspaceScope'
                : 'workspace:usageSelfScope',
            )}{' '}
            · {data.period.since.slice(0, 10)} — {data.period.until.slice(0, 10)} · UTC
          </p>
          <div className="usage-summary">
            <div>
              <span>{uiText('workspace:usageModelTurns')}</span>
              <strong>{formatNumber(data.totals.modelTurns)}</strong>
            </div>
            <div>
              <span>{uiText('workspace:usageTotalTokens')}</span>
              <strong>{formatNumber(data.totals.totalTokens)}</strong>
            </div>
            <div>
              <span>{uiText('workspace:usageUnreported')}</span>
              <strong>{formatNumber(data.totals.unreportedTurns)}</strong>
            </div>
          </div>
          <dl className="usage-token-details">
            <div>
              <dt>{uiText('workspace:usageInput')}</dt>
              <dd>{formatNumber(data.totals.inputTokens)}</dd>
            </div>
            <div>
              <dt>{uiText('workspace:usageOutput')}</dt>
              <dd>{formatNumber(data.totals.outputTokens)}</dd>
            </div>
            <div>
              <dt>{uiText('workspace:usageCacheRead')}</dt>
              <dd>{formatNumber(data.totals.cacheReadTokens)}</dd>
            </div>
            <div>
              <dt>{uiText('workspace:usageCacheWrite')}</dt>
              <dd>{formatNumber(data.totals.cacheWriteTokens)}</dd>
            </div>
          </dl>
          <p className="field-help">
            {uiText('workspace:usageReportedHint', {
              reported: data.totals.reportedTurns,
              all: data.totals.modelTurns,
            })}
          </p>
          <div className="usage-cost">
            <strong>{uiText('workspace:usageCostUnknown')}</strong>
            <p>{uiText('workspace:usageCostHint')}</p>
          </div>
          {!data.totals.modelTurns ? (
            <p className="usage-empty">{uiText('workspace:usageEmpty')}</p>
          ) : (
            <>
              <UsageTableView
                title={uiText('workspace:usageByBot')}
                rows={data.byBot.map((row) => ({
                  id: row.agentId ?? 'system',
                  label:
                    row.agentId === null
                      ? uiText('workspace:usageSystemTasks')
                      : row.name || uiText('workspace:usageRemovedBot'),
                  totals: row.totals,
                }))}
              />
              <UsageTableView
                title={uiText('workspace:usageByModel')}
                rows={data.byModel.map((row) => ({
                  id: JSON.stringify([row.provider, row.model]),
                  label:
                    [row.provider, row.model].filter(Boolean).join(' / ') ||
                    uiText('workspace:usageUnknownModel'),
                  totals: row.totals,
                }))}
              />
              <details className="usage-daily">
                <summary>{uiText('workspace:usageByDay')}</summary>
                <UsageTableView
                  title={uiText('workspace:usageDateUTC')}
                  rows={data.byDay.map((row) => ({
                    id: row.day,
                    label: row.day,
                    totals: row.totals,
                  }))}
                />
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
function UsageTableView({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; label: string; totals: UsageTotals }>;
}) {
  return (
    <div className="usage-table-wrap">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{uiText('workspace:usageItem')}</th>
            <th scope="col">{uiText('workspace:usageModelTurns')}</th>
            <th scope="col">{uiText('workspace:usageTotalTokens')}</th>
            <th scope="col">{uiText('workspace:usageUnreported')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              <td>{formatNumber(row.totals.modelTurns)}</td>
              <td>{formatNumber(row.totals.totalTokens)}</td>
              <td>{formatNumber(row.totals.unreportedTurns)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

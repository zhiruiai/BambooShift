import { ArrowUpRight, ChevronRight, Globe2 } from 'lucide-react';
import type { WebResearch, WebResearchIssue } from '../../../shared/web-research';
import { formatNumber, uiText, type UiTextKey } from '../i18n';
import './WebResearchCard.css';

const issueText: Record<WebResearchIssue, UiTextKey> = {
  search_task_limit: 'workspace:webResearchSearchTaskLimit',
  search_retry_limit: 'workspace:webResearchSearchRetryLimit',
  fetch_task_limit: 'workspace:webResearchFetchTaskLimit',
  upstream_rate_limit: 'workspace:webResearchProviderRateLimit',
  timeout: 'workspace:webResearchTimeout',
  unavailable: 'workspace:webResearchUnavailable',
  fetch_empty: 'workspace:webResearchFetchEmpty',
  failed: 'workspace:webResearchFailed',
};

export function WebResearchCard({ research }: { research: WebResearch }) {
  const counts = [
    ['workspace:webResearchSearches', research.searches],
    ['workspace:webResearchCached', research.cachedSearches],
    ['workspace:webResearchEmptySearches', research.emptySearches],
    ['workspace:webResearchPages', research.pagesRead],
  ] as const;
  const [firstIssue] = research.issues;
  const desktop =
    typeof document !== 'undefined' && document.documentElement.dataset.openbotDesktop === 'true';
  return (
    <details className="web-research-card">
      <summary className="web-research-summary">
        <Globe2 size={16} aria-hidden="true" />
        <span className="web-research-summary-content">
          <span className="web-research-heading">
            <strong>{uiText('workspace:webResearchTitle')}</strong>
            <span>{research.provider}</span>
          </span>
          {counts.some(([, count]) => count > 0) && (
            <span className="web-research-stats">
              {counts.map(([label, count]) =>
                count > 0 ? (
                  <span key={label}>{uiText(label, { total: formatNumber(count) })}</span>
                ) : null,
              )}
            </span>
          )}
          {firstIssue && (
            <span className="web-research-status">{uiText(issueText[firstIssue])}</span>
          )}
        </span>
        <ChevronRight className="web-research-chevron" size={15} aria-hidden="true" />
      </summary>
      <div className="web-research-details">
        {research.issues.length > 1 && (
          <ul className="web-research-issues">
            {research.issues.slice(1).map((issue) => (
              <li key={issue}>{uiText(issueText[issue])}</li>
            ))}
          </ul>
        )}
        <strong>{uiText('workspace:webResearchSources')}</strong>
        {research.sources.length > 0 ? (
          <>
            {desktop && (
              <p className="web-research-desktop-hint">
                {uiText('workspace:updatesDesktopLinkHint')}
              </p>
            )}
            <ul className="web-research-sources">
              {research.sources.map(({ title, url, kind }) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    <span className="web-research-source-copy">
                      <span className="web-research-source-title">{title}</span>
                      <span className="web-research-source-meta">
                        {new URL(url).hostname} ·{' '}
                        {uiText(
                          kind === 'page'
                            ? 'workspace:webResearchSourceRead'
                            : 'workspace:webResearchSourceSearch',
                        )}
                      </span>
                    </span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="web-research-empty">{uiText('workspace:webResearchNoSources')}</p>
        )}
      </div>
    </details>
  );
}

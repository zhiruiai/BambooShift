import { useEffect, useState } from 'react';
import { uiText } from '../i18n';
import { websiteDiffMaxBytes, websiteTextDiff, type WebsiteTextDiff } from '../websiteTextDiff';
import {
  websiteProjectClient,
  type WebsiteAsset,
  type WebsiteProjectSummary,
} from '../websiteProjects';
import './WebsiteFileDiff.css';

type State = { kind: 'loading' | 'error' | 'binary' | 'large' } | WebsiteTextDiff;
const textFile = (file: WebsiteAsset) =>
  file.mime.startsWith('text/') ||
  file.mime === 'application/json' ||
  file.mime === 'image/svg+xml';

export function WebsiteFileDiff({
  before,
  after,
  baseline,
  project,
  access,
}: {
  before?: WebsiteAsset;
  after?: WebsiteAsset;
  baseline: WebsiteProjectSummary;
  project: WebsiteProjectSummary;
  access: Parameters<typeof websiteProjectClient>[1];
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const files = [before, after].filter((file): file is WebsiteAsset => !!file);
    if (files.some((file) => !textFile(file))) {
      setState({ kind: 'binary' });
      return;
    }
    if (files.some((file) => file.size > websiteDiffMaxBytes)) {
      setState({ kind: 'large' });
      return;
    }
    setState({ kind: 'loading' });
    const read = async (summary: WebsiteProjectSummary, file?: WebsiteAsset) => {
      if (!file) return '';
      const loaded = await websiteProjectClient(summary, access).file(file, signal);
      return new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
    };
    void Promise.all([read(baseline, before), read(project, after)])
      .then(([old, next]) => {
        if (signal.aborted || !access.current()) return;
        setState(
          old.includes('\0') || next.includes('\0')
            ? { kind: 'binary' }
            : websiteTextDiff(old, next),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted && access.current()) setState({ kind: 'error' });
        controller.abort();
      });
    return () => controller.abort();
  }, [before, after, baseline, project, access, attempt]);

  if (state.kind !== 'ready')
    return (
      <div className="website-file-diff-status" role={state.kind === 'error' ? 'alert' : 'status'}>
        <p>
          {uiText(
            state.kind === 'loading'
              ? 'workspace:websiteDiffLoading'
              : state.kind === 'error'
                ? 'workspace:websiteDiffFailed'
                : state.kind === 'binary'
                  ? 'workspace:websiteDiffBinary'
                  : 'workspace:websiteDiffLimited',
          )}
        </p>
        {state.kind === 'error' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {uiText('workspace:filePreviewRetry')}
          </button>
        )}
      </div>
    );
  return (
    <div className="website-file-diff">
      <p className="website-file-diff-summary">
        {uiText('workspace:websiteDiffCount', { added: state.added, removed: state.removed })}
      </p>
      {state.formatOnly && <p>{uiText('workspace:websiteDiffLineEndings')}</p>}
      {!state.added && !state.removed && !state.formatOnly && (
        <p>{uiText('workspace:websiteNoFileChanges')}</p>
      )}
      {!!state.rows.length && (
        <div className="website-file-diff-scroll" tabIndex={0}>
          <table aria-label={uiText('workspace:websiteDiffLines')}>
            <colgroup>
              <col className="website-diff-number" />
              <col className="website-diff-number" />
              <col className="website-diff-sign" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{uiText('workspace:websiteDiffBefore')}</th>
                <th scope="col">{uiText('workspace:websiteDiffAfter')}</th>
                <th scope="col" colSpan={2}>
                  {uiText('workspace:websiteDiffContent')}
                </th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row, index) =>
                row.kind === 'gap' ? (
                  <tr className="website-diff-gap" key={index}>
                    <td colSpan={4}>
                      {uiText('workspace:websiteDiffUnchanged', { count: row.count })}
                    </td>
                  </tr>
                ) : (
                  <tr className={`website-diff-${row.kind}`} key={index}>
                    <td className="website-diff-number">{row.before ?? ''}</td>
                    <td className="website-diff-number">{row.after ?? ''}</td>
                    <td
                      className="website-diff-sign"
                      aria-label={
                        row.kind === 'added'
                          ? uiText('workspace:websiteDiffAddedLine')
                          : row.kind === 'removed'
                            ? uiText('workspace:websiteDiffRemovedLine')
                            : undefined
                      }
                    >
                      {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}
                    </td>
                    <td className="website-diff-code">
                      <code>{row.text || ' '}</code>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      {state.truncated && <p role="status">{uiText('workspace:websiteDiffTruncated')}</p>}
    </div>
  );
}

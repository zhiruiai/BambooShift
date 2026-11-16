import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { uiText } from '../i18n';
import {
  websiteProjectClient,
  type WebsiteAsset,
  type WebsiteProjectSummary,
  type WebsiteProjectVersion,
} from '../websiteProjects';
import { websiteDeliveryTime } from './WebsiteVersionHistory';
import { WebsiteFileDiff } from './WebsiteFileDiff';

function compareFiles(before: WebsiteAsset[], after: WebsiteAsset[]) {
  const oldFiles = new Map(before.map((file) => [file.path, file]));
  const newFiles = new Map(after.map((file) => [file.path, file]));
  return {
    added: after.filter(({ path }) => !oldFiles.has(path)),
    modified: after.filter(({ path, sha256 }) => {
      const old = oldFiles.get(path);
      return old && old.sha256 !== sha256;
    }),
    removed: before.filter(({ path }) => !newFiles.has(path)),
  };
}

type ChangesState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; files: ReturnType<typeof compareFiles>; before: WebsiteAsset[] };

export function WebsiteVersionChanges({
  project,
  previous,
  access,
  loadCurrent,
  currentVersion,
}: {
  project: WebsiteProjectSummary;
  previous: WebsiteProjectVersion;
  access: Parameters<typeof websiteProjectClient>[1];
  loadCurrent: (signal: AbortSignal) => Promise<WebsiteAsset[]>;
  currentVersion?: number;
}) {
  const [state, setState] = useState<ChangesState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [baseline] = useState(previous.project);
  const [selected, setSelected] = useState<string>();
  const id = useId();

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    setState({ kind: 'loading' });
    setSelected(undefined);
    const client = websiteProjectClient(baseline, access);
    void Promise.all([client.manifest(signal), loadCurrent(signal)])
      .then(([before, after]) => {
        if (!signal.aborted && access.current())
          setState({ kind: 'ready', files: compareFiles(before, after), before });
      })
      .catch(() => {
        if (!controller.signal.aborted && access.current()) setState({ kind: 'error' });
        controller.abort();
      });
    return () => controller.abort();
  }, [access, attempt, baseline, loadCurrent]);

  if (state.kind === 'loading')
    return (
      <p role="status" className="website-project-status">
        {uiText('workspace:websiteChangesLoading')}
      </p>
    );
  if (state.kind === 'error')
    return (
      <div className="website-project-status" role="alert">
        <p>{uiText('workspace:websiteChangesFailed')}</p>
        <button className="secondary-button" type="button" onClick={() => setAttempt((n) => n + 1)}>
          {uiText('workspace:filePreviewRetry')}
        </button>
      </div>
    );

  const groups = [
    { files: state.files.added, key: 'workspace:websiteChangesAdded' },
    { files: state.files.modified, key: 'workspace:websiteChangesModified' },
    { files: state.files.removed, key: 'workspace:websiteChangesRemoved' },
  ] as const;
  return (
    <div className="website-version-changes" tabIndex={0}>
      <p className="website-diff-direction">
        {uiText('workspace:websiteDiffDirection', {
          from: uiText('workspace:websiteVersionNumber', { number: previous.number }),
          to:
            currentVersion === undefined
              ? project.title
              : uiText('workspace:websiteVersionNumber', { number: currentVersion }),
        })}
      </p>
      <p>
        {uiText('workspace:websiteComparedWith', {
          title: baseline.title,
          date: websiteDeliveryTime(previous.message.createdAt),
        })}
      </p>
      {baseline.title !== project.title && (
        <p>
          {uiText('workspace:websiteTitleChanged', { from: baseline.title, to: project.title })}
        </p>
      )}
      {baseline.entry !== project.entry && (
        <p>
          {uiText('workspace:websiteEntryChanged', { from: baseline.entry, to: project.entry })}
        </p>
      )}
      {groups.every(({ files }) => files.length === 0) && (
        <p>{uiText('workspace:websiteNoFileChanges')}</p>
      )}
      {groups.map(
        ({ files, key }) =>
          files.length > 0 && (
            <section key={key}>
              <h3>{uiText(key, { count: files.length })}</h3>
              <ul className="website-diff-files">
                {files.map((file) => {
                  const open = selected === file.path;
                  const detailId = `${id}-${encodeURIComponent(file.path)}`;
                  const removed = key === 'workspace:websiteChangesRemoved';
                  return (
                    <li className="website-diff-file" key={file.path}>
                      <button
                        type="button"
                        className="website-diff-file-toggle"
                        aria-expanded={open}
                        aria-controls={detailId}
                        onClick={() => setSelected(open ? undefined : file.path)}
                      >
                        {open ? (
                          <ChevronDown size={14} aria-hidden="true" />
                        ) : (
                          <ChevronRight size={14} aria-hidden="true" />
                        )}
                        <code>{file.path}</code>
                      </button>
                      {open && (
                        <div id={detailId}>
                          <WebsiteFileDiff
                            baseline={baseline}
                            project={project}
                            access={access}
                            before={
                              removed ? file : state.before.find((old) => old.path === file.path)
                            }
                            after={removed ? undefined : file}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ),
      )}
    </div>
  );
}

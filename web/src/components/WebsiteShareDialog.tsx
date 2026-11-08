import { Copy, ExternalLink, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  parseWebsiteShare,
  type WebsiteShare,
  type WebsiteVisibility,
} from '../../../shared/website-shares';
import { ApiError } from '../api';
import type { FixedWorkspaceApi } from '../fixedWorkspaceApi';
import { uiText } from '../i18n';
import { platformApi } from '../platform/platformApi';
import type { WebsiteProjectSummary } from '../websiteProjects';
import { Dialog } from './UI';
import './WebsiteShareDialog.css';

const visibilityText = {
  private: 'workspace:websiteSharePrivate',
  invited: 'workspace:websiteShareInvited',
  team: 'workspace:websiteShareTeam',
  public: 'workspace:websiteSharePublic',
} as const;

type Member = { userId: string; name: string; status: string };
const pathFor = (id: string) => `/website-projects/${id}/share`;

export function WebsiteShareDialog({
  project,
  workspaceId,
  userId,
  team,
  api,
  current,
  onClose,
}: {
  project: WebsiteProjectSummary;
  workspaceId: string;
  userId: string;
  team: boolean;
  api: FixedWorkspaceApi;
  current: () => boolean;
  onClose: () => void;
}) {
  const [share, setShare] = useState<WebsiteShare>();
  const [members, setMembers] = useState<Member[]>();
  const [visibility, setVisibility] = useState<WebsiteVisibility>('private');
  const [viewers, setViewers] = useState<string[]>([]);
  const [rotate, setRotate] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const operation = useRef(0);
  const isCurrent = useRef(current);
  isCurrent.current = current;
  const requestApi = useRef(api);
  requestApi.current = api;
  const inFlight = useRef(false);

  function apply(value: WebsiteShare) {
    setShare(value);
    setVisibility(value.visibility);
    setViewers(value.viewerIds);
    setRotate(false);
    setReviewed(false);
  }
  useEffect(() => {
    const id = ++operation.current;
    const controller = new AbortController();
    const active = () => operation.current === id && isCurrent.current();
    setShare(undefined);
    setError('');
    setMembers(undefined);
    void requestApi
      .current<unknown>(pathFor(project.id))
      .then((result) => {
        const next = parseWebsiteShare(result);
        if (!next) throw Error('Invalid website share');
        if (active()) apply(next);
      })
      .catch((cause) => {
        if (active())
          setError(
            uiText(
              cause instanceof ApiError && [403, 404].includes(cause.status)
                ? 'workspace:websiteSharePermission'
                : 'workspace:websiteShareLoadFailed',
            ),
          );
      });
    if (team)
      void platformApi<{ members?: Member[] }>(
        `/account/workspaces/${encodeURIComponent(workspaceId)}/team`,
        'GET',
        undefined,
        { signal: controller.signal, expectedUser: userId },
      )
        .then((result) => {
          if (active() && Array.isArray(result.members)) {
            setMembers(
              result.members.filter(
                (member) =>
                  member.status === 'active' &&
                  typeof member.userId === 'string' &&
                  /^[a-zA-Z0-9_-]{1,128}$/.test(member.userId) &&
                  typeof member.name === 'string',
              ),
            );
          }
        })
        .catch(() => {});
    return () => {
      operation.current++;
      controller.abort();
    };
  }, [attempt, project.id, team, userId, workspaceId]);

  const enabledViewers = (members || [])
    .filter((member) => viewers.includes(member.userId))
    .map((member) => member.userId);
  const changedVersion = !!share && visibility !== 'private' && share.versionId !== project.id;
  const changedViewers =
    visibility === 'invited' &&
    (enabledViewers.length !== share?.viewerIds.length ||
      enabledViewers.some((viewer) => !share?.viewerIds.includes(viewer)));
  const changed =
    !!share && (share.visibility !== visibility || changedVersion || changedViewers || rotate);
  const canSave =
    changed &&
    !busy &&
    (visibility !== 'public' || reviewed) &&
    (visibility !== 'invited' || members !== undefined);
  const link = share?.path ? new URL(share.path, window.location.origin).href : '';
  const stale = !!share?.path && share.versionId !== project.id;

  async function save() {
    if (!canSave || !share || inFlight.current || !isCurrent.current()) return;
    const id = operation.current;
    const active = () => operation.current === id && isCurrent.current();
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = parseWebsiteShare(
        await requestApi.current<unknown>(pathFor(project.id), 'PUT', {
          visibility,
          expectedRevision: share.revision,
          ...(visibility === 'invited' ? { viewerIds: enabledViewers } : {}),
          ...(rotate ? { rotate: true } : {}),
        }),
      );
      if (
        !next ||
        next.visibility !== visibility ||
        (visibility !== 'private' && next.versionId !== project.id)
      ) {
        throw Error('Invalid website share receipt');
      }
      if (active()) {
        apply(next);
        setNotice(uiText('workspace:websiteShareSaved'));
      }
    } catch (cause) {
      if (active()) {
        setShare(undefined);
        setError(
          uiText(
            cause instanceof ApiError && cause.status === 409
              ? 'workspace:websiteShareConflict'
              : 'workspace:websiteShareSaveFailed',
          ),
        );
      }
    } finally {
      inFlight.current = false;
      if (active()) setBusy(false);
    }
  }

  return (
    <Dialog
      title={uiText('workspace:websiteShare')}
      subtitle={project.title}
      className="website-share-dialog"
      portal
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {!share && !error && <p role="status">{uiText('workspace:websiteLoading')}</p>}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {!share && error && (
        <button type="button" className="secondary-button" onClick={() => setAttempt(attempt + 1)}>
          <RotateCw size={15} aria-hidden="true" />
          {uiText('workspace:filePreviewRetry')}
        </button>
      )}
      {share && (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            {uiText('workspace:websiteShareWho')}
            <select
              value={visibility}
              disabled={busy}
              onChange={(event) => {
                setVisibility(event.target.value as WebsiteVisibility);
                setReviewed(false);
                setRotate(false);
                setNotice('');
              }}
            >
              <option value="private">{uiText(visibilityText.private)}</option>
              {team && <option value="invited">{uiText(visibilityText.invited)}</option>}
              {team && <option value="team">{uiText(visibilityText.team)}</option>}
              <option value="public">{uiText(visibilityText.public)}</option>
            </select>
          </label>
          {visibility === 'invited' && (
            <fieldset disabled={busy} className="website-share-viewers">
              <legend>{uiText('workspace:websiteShareChooseViewers')}</legend>
              {!members?.length && <p>{uiText('workspace:websiteShareNoViewers')}</p>}
              {members?.map((member) => (
                <label key={member.userId}>
                  <input
                    type="checkbox"
                    checked={viewers.includes(member.userId)}
                    disabled={viewers.length >= 80 && !viewers.includes(member.userId)}
                    onChange={(event) =>
                      setViewers(
                        event.target.checked
                          ? [...viewers, member.userId]
                          : viewers.filter((id) => id !== member.userId),
                      )
                    }
                  />
                  <span>{member.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          {visibility !== 'private' && (
            <p className="field-help">
              {uiText(
                stale
                  ? 'workspace:websiteShareVersionUpdate'
                  : 'workspace:websiteSharePinnedVersion',
              )}
            </p>
          )}
          {changed && visibility === 'public' && (
            <label className="website-share-check">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={busy}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              {uiText('workspace:websiteSharePublicConfirm')}
            </label>
          )}
          {link && (
            <>
              <label>
                {uiText('workspace:websiteShareLink')}
                <input value={link} readOnly />
              </label>
              <div className="website-share-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      if (isCurrent.current()) setNotice(uiText('workspace:websiteShareCopied'));
                    } catch {
                      if (isCurrent.current())
                        setNotice(uiText('workspace:websiteShareCopyFailed'));
                    }
                  }}
                >
                  <Copy size={15} aria-hidden="true" />
                  {uiText('workspace:websiteShareCopy')}
                </button>
                <a
                  className="secondary-button"
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={15} aria-hidden="true" />
                  {uiText('workspace:websiteShareOpen')}
                </a>
              </div>
              {visibility !== 'private' && (
                <label className="website-share-check">
                  <input
                    type="checkbox"
                    checked={rotate}
                    disabled={busy}
                    onChange={(event) => setRotate(event.target.checked)}
                  />
                  {uiText('workspace:websiteShareRotate')}
                </label>
              )}
            </>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className="website-share-actions">
            <button type="submit" className="primary-button" disabled={!canSave}>
              {uiText(
                visibility === 'private' && !!share.path
                  ? 'workspace:websiteShareRevoke'
                  : 'workspace:websiteShareSave',
              )}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

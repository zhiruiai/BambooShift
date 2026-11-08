import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../../../shared/types';
import { WebsiteProjectPanel } from '../components/WebsiteProjectPanel';
import { WebsiteShareDialog } from '../components/WebsiteShareDialog';
import type { FixedWorkspaceApi } from '../fixedWorkspaceApi';
import {
  websiteProjectClient,
  websiteProjectFor,
  type WebsiteProjectSummary,
  type WebsiteProjectViewState,
} from '../websiteProjects';
import type { WorkspaceModel } from './types';
import './WorkspaceWebsite.css';

type OpenedProject = { scope: string; messageId: string; project: WebsiteProjectSummary };

export function useWorkspaceWebsite(model: WorkspaceModel) {
  const scope = `${model.navigationScope}:${model.selected}`;
  const [opened, setOpened] = useState<OpenedProject>();
  const trigger = useRef<HTMLElement | null>(null);
  const ticket = model.sendScope.ticket();
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const current = () => latestScope.current === scope && model.sendScope.current(ticket);
  const active =
    opened?.scope === scope && model.messages.find((message) => message.id === opened.messageId);
  const workspaceId = model.account?.workspace.id;
  const userId = model.currentUserId;
  useEffect(
    () => setOpened((previous) => (previous?.scope === scope ? previous : undefined)),
    [scope],
  );

  function open(message: Message) {
    const project = websiteProjectFor(message);
    if (
      !project ||
      !workspaceId ||
      !userId ||
      !current() ||
      model.modal ||
      message.conversationId !== model.selected ||
      !model.messages.some((entry) => entry.id === message.id)
    )
      return;
    if (!active) trigger.current = document.activeElement as HTMLElement | null;
    setOpened({ scope, messageId: message.id, project });
  }
  function openSearchResult(message: Message) {
    const project = websiteProjectFor(message);
    if (!project || !workspaceId || !userId || !current() || model.modal !== 'search') return;
    trigger.current = null;
    setOpened({
      scope: `${model.navigationScope}:${message.conversationId}`,
      messageId: message.id,
      project,
    });
    model.jumpToMessage(message.conversationId, message.id);
  }
  function close(restoreFocus: boolean) {
    setOpened(undefined);
    if (restoreFocus)
      requestAnimationFrame(() => {
        if (!current()) return;
        if (trigger.current?.isConnected) trigger.current.focus();
        else model.composerRef.current?.focus();
      });
  }
  const newest =
    active &&
    opened &&
    [...model.messages]
      .reverse()
      .find((message) => websiteProjectFor(message)?.projectKey === opened.project.projectKey);
  const onOpenLatest =
    newest && websiteProjectFor(newest)?.id !== opened?.project.id ? () => open(newest) : undefined;
  const panel =
    active && opened && workspaceId && userId ? (
      <WorkspaceWebsite
        key={`${scope}:${opened.project.id}`}
        project={opened.project}
        workspaceId={workspaceId}
        userId={userId}
        team={model.account?.workspace.kind === 'team'}
        api={model.api}
        current={current}
        onOpenLatest={onOpenLatest}
        onClose={() => close(true)}
        onDiscuss={() => {
          if (!current()) return;
          if (window.matchMedia('(max-width: 900px)').matches) close(false);
          requestAnimationFrame(() => {
            if (current()) model.beginReply(active);
          });
        }}
      />
    ) : null;
  return {
    panel,
    open: workspaceId && userId ? open : undefined,
    openSearchResult: workspaceId && userId ? openSearchResult : undefined,
  };
}

function WorkspaceWebsite({
  project,
  workspaceId,
  userId,
  team,
  api,
  current,
  onClose,
  onDiscuss,
  onOpenLatest,
}: {
  project: WebsiteProjectSummary;
  workspaceId: string;
  userId: string;
  team: boolean;
  api: FixedWorkspaceApi;
  current: () => boolean;
  onClose: () => void;
  onDiscuss: () => void;
  onOpenLatest?: () => void;
}) {
  const isCurrent = useRef(current);
  isCurrent.current = current;
  const client = useMemo(
    () =>
      websiteProjectClient(project, { workspaceId, userId, current: () => isCurrent.current() }),
    [project, workspaceId, userId],
  );
  const [attempt, setAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [state, setState] = useState<WebsiteProjectViewState>({ kind: 'loading' });
  const downloadRequest = useRef<AbortController | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    setState({ kind: 'loading' });
    void client
      .load(signal)
      .then((files) => {
        if (!signal.aborted && isCurrent.current()) setState({ kind: 'ready', files });
      })
      .catch(() => {
        if (!controller.signal.aborted && isCurrent.current()) setState({ kind: 'error' });
        controller.abort();
      });
    return () => controller.abort();
  }, [client, attempt]);
  useEffect(() => () => downloadRequest.current?.abort(), []);

  async function download() {
    if (downloadRequest.current || !isCurrent.current()) return;
    const request = new AbortController();
    downloadRequest.current = request;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      await client.download(AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]));
    } catch {
      if (!request.signal.aborted && isCurrent.current()) setDownloadFailed(true);
    } finally {
      downloadRequest.current = undefined;
      if (!request.signal.aborted && isCurrent.current()) setDownloading(false);
    }
  }

  return (
    <>
      <WebsiteProjectPanel
        project={project}
        state={state}
        onClose={onClose}
        onDiscuss={onDiscuss}
        onRetry={() => setAttempt((value) => value + 1)}
        onDownload={() => void download()}
        downloading={downloading}
        downloadFailed={downloadFailed}
        onOpenLatest={onOpenLatest}
        onShare={state.kind === 'ready' ? () => setSharing(true) : undefined}
      />
      {sharing && (
        <WebsiteShareDialog
          project={project}
          workspaceId={workspaceId}
          userId={userId}
          team={team}
          api={api}
          current={() => isCurrent.current()}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  );
}

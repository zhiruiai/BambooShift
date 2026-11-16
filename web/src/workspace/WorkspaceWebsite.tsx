import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../../../shared/types';
import { composerScopeKey } from '../chatDrafts';
import { useProjectOverlay, WebsiteProjectPanel } from '../components/WebsiteProjectPanel';
import { WebsiteShareDialog } from '../components/WebsiteShareDialog';
import { WebsiteVersionChanges } from '../components/WebsiteVersionChanges';
import { websiteVersionNumber } from '../components/WebsiteVersionHistory';
import type { FixedWorkspaceApi } from '../fixedWorkspaceApi';
import {
  websiteProjectClient,
  websiteProjectFor,
  websiteProjectHistory,
  type WebsiteProjectSummary,
  type WebsiteProjectVersion,
  type WebsiteProjectViewState,
} from '../websiteProjects';
import type { WorkspaceModel } from './types';
import './WorkspaceWebsite.css';

type OpenedProject = { scope: string; messageId: string; project: WebsiteProjectSummary };

export type WebsiteEditContext = {
  message: Message;
  title: string;
  version?: number;
  fromPreview: boolean;
  cancel: () => void;
};

export function useWorkspaceWebsite(model: WorkspaceModel) {
  const scope = `${model.navigationScope}:${model.selected}`;
  const overlay = useProjectOverlay();
  const [opened, setOpened] = useState<OpenedProject>();
  const [dismissed, setDismissed] = useState<string>();
  const trigger = useRef<HTMLElement | null>(null);
  const ticket = model.sendScope.ticket();
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const current = () => latestScope.current === scope && model.sendScope.current(ticket);
  const active =
    opened?.scope === scope
      ? model.data.messages.find(
          (message) => message.id === opened.messageId && message.conversationId === model.selected,
        )
      : undefined;
  const project = active ? opened?.project : undefined;
  const projectKey = project?.projectKey;
  const versions = useMemo(
    () =>
      projectKey ? websiteProjectHistory(model.data.messages, model.selected, projectKey) : [],
    [model.data.messages, model.selected, projectKey],
  );
  const workspaceId = model.account?.workspace.id;
  const userId = model.currentUserId;
  useEffect(
    () => setOpened((previous) => (previous?.scope === scope ? previous : undefined)),
    [scope],
  );

  function goToDelivery(message: Message) {
    if (message.threadRootId !== model.threadRootId)
      model.jumpToMessage(message.conversationId, message.id, !message.threadRootId);
  }

  function open(message: Message) {
    const project = websiteProjectFor(message);
    if (
      !project ||
      !workspaceId ||
      !userId ||
      !current() ||
      model.modal ||
      message.conversationId !== model.selected ||
      !model.data.messages.some((entry) => entry.id === message.id)
    )
      return;
    if (!active) trigger.current = document.activeElement as HTMLElement | null;
    setDismissed(undefined);
    setOpened({ scope, messageId: message.id, project });
    if (!overlay) goToDelivery(message);
  }
  function openSearchResult(message: Message) {
    const project = websiteProjectFor(message);
    if (!project || !workspaceId || !userId || !current() || model.modal !== 'search') return;
    trigger.current = null;
    setDismissed(undefined);
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
  const explicit =
    model.replyTo?.kind === 'website_project'
      ? model.data.messages.find(
          (message) =>
            message.id === model.replyTo?.id &&
            message.conversationId === model.selected &&
            message.threadRootId === model.threadRootId,
        )
      : undefined;
  const fromPreview =
    !overlay &&
    !model.replyTo &&
    !model.currentComposer.requestVoiceMemo &&
    !!active &&
    active.id !== dismissed &&
    active.threadRootId === model.threadRootId;
  const destination = explicit ?? (fromPreview ? active : undefined);
  const destinationProject =
    destination === active ? project : destination && websiteProjectFor(destination);
  const editContext: WebsiteEditContext | undefined =
    destination && destinationProject
      ? {
          message: destination,
          title: destinationProject.title,
          version: websiteVersionNumber(
            destinationProject.projectKey === projectKey
              ? versions
              : websiteProjectHistory(
                  model.data.messages,
                  model.selected,
                  destinationProject.projectKey,
                ),
            destinationProject.id,
          ),
          fromPreview,
          cancel: () => {
            setDismissed(active?.id);
            if (explicit)
              model.updateComposer(model.composerKey, (draft) =>
                draft.replyTo?.id === explicit.id ? { ...draft, replyTo: undefined } : draft,
              );
            model.composerRef.current?.focus();
          },
        }
      : undefined;

  const panel =
    active && project && workspaceId && userId ? (
      <WorkspaceWebsite
        key={`${scope}:${project.id}`}
        project={project}
        versions={versions}
        workspaceId={workspaceId}
        userId={userId}
        team={model.account?.workspace.kind === 'team'}
        api={model.api}
        current={current}
        onOpenVersion={open}
        onClose={() => close(true)}
        onDiscuss={() => {
          if (!current()) return;
          const key = composerScopeKey(active.conversationId, active.threadRootId);
          model.updateComposer(key, (draft) => ({
            ...draft,
            replyTo: undefined,
            requestVoiceMemo: undefined,
          }));
          if (overlay) close(false);
          else setDismissed(undefined);
          goToDelivery(active);
          requestAnimationFrame(() => {
            if (!current()) return;
            if (overlay) model.beginReply(active, { threadRootId: active.threadRootId });
            else model.composerRef.current?.focus({ preventScroll: true });
          });
        }}
      />
    ) : null;
  return {
    panel,
    editContext,
    dismiss: () => close(false),
    open: workspaceId && userId ? open : undefined,
    openSearchResult: workspaceId && userId ? openSearchResult : undefined,
  };
}

function WorkspaceWebsite({
  project,
  versions,
  workspaceId,
  userId,
  team,
  api,
  current,
  onClose,
  onDiscuss,
  onOpenVersion,
}: {
  project: WebsiteProjectSummary;
  versions: WebsiteProjectVersion[];
  workspaceId: string;
  userId: string;
  team: boolean;
  api: FixedWorkspaceApi;
  current: () => boolean;
  onClose: () => void;
  onDiscuss: () => void;
  onOpenVersion: (message: Message) => void;
}) {
  const isCurrent = useRef(current);
  isCurrent.current = current;
  const access = useMemo(
    () => ({ workspaceId, userId, current: () => isCurrent.current() }),
    [workspaceId, userId],
  );
  const client = useMemo(() => websiteProjectClient(project, access), [project, access]);
  const versionIndex = versions.findIndex(({ project: version }) => version.id === project.id);
  const previous = versionIndex >= 0 ? versions[versionIndex + 1] : undefined;
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
        versions={versions}
        onOpenVersion={onOpenVersion}
        changes={
          previous && (
            <WebsiteVersionChanges
              key={previous.project.id}
              project={project}
              previous={previous}
              currentVersion={versions[versionIndex]?.number}
              access={access}
              loadCurrent={client.manifest}
            />
          )
        }
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

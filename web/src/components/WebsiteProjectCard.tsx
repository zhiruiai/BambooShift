import { Globe2, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import type { Message } from '../../../shared/types';
import { uiText } from '../i18n';
import {
  websiteProjectFor,
  type OpenWebsiteProject,
  type WebsiteProjectVersion,
} from '../websiteProjects';

export function latestWebsiteUpdates(messages: readonly Message[], conversationId?: string) {
  const updates = new Map<string, Message>();
  if (!conversationId) return updates;
  const latestVersions = new Map<string, Pick<WebsiteProjectVersion, 'message' | 'project'>>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.conversationId !== conversationId) continue;
    const project = websiteProjectFor(message);
    if (!project) continue;
    const latest = latestVersions.get(project.projectKey);
    if (!latest) latestVersions.set(project.projectKey, { message, project });
    else if (latest.project.id !== project.id) updates.set(message.id, latest.message);
  }
  return updates;
}

export function useWebsiteUpdates(messages: readonly Message[], conversationId?: string) {
  return useMemo(() => latestWebsiteUpdates(messages, conversationId), [messages, conversationId]);
}

export function WebsiteProjectCard({
  message,
  latest,
  onOpen,
}: {
  message: Message;
  latest?: Message;
  onOpen?: OpenWebsiteProject;
}) {
  const project = websiteProjectFor(message);
  if (!project) return <div className="message-bubble">{message.content}</div>;
  const original = (
    <button
      type="button"
      className="file-card website-project-card"
      disabled={!onOpen}
      aria-label={`${uiText('workspace:websiteOpen')} ${project.title}`}
      onClick={() => onOpen?.(message)}
    >
      <span className="file-icon">
        <Globe2 size={20} aria-hidden="true" />
      </span>
      <span className="file-copy">
        <strong>{project.title}</strong>
        <small>
          {uiText('workspace:websiteProject')} ·{' '}
          {uiText('workspace:websiteFileCount', { count: project.fileCount })}
        </small>
      </span>
      <ChevronRight size={15} aria-hidden="true" />
    </button>
  );
  return latest && onOpen ? (
    <div className="website-project-updated">
      {original}
      <button type="button" className="website-project-update" onClick={() => onOpen(latest)}>
        {uiText('workspace:websiteOpenLatest')}
        <ChevronRight size={13} aria-hidden="true" />
      </button>
    </div>
  ) : (
    original
  );
}

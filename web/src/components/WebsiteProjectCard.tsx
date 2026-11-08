import { Globe2, ChevronRight } from 'lucide-react';
import type { Message } from '../../../shared/types';
import { uiText } from '../i18n';
import { websiteProjectFor, type OpenWebsiteProject } from '../websiteProjects';

export function WebsiteProjectCard({
  message,
  onOpen,
}: {
  message: Message;
  onOpen?: OpenWebsiteProject;
}) {
  const project = websiteProjectFor(message);
  if (!project) return <div className="message-bubble">{message.content}</div>;
  return (
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
}

export function WebsiteProjectLibrary({
  messages,
  onOpen,
}: {
  messages: readonly Message[];
  onOpen: OpenWebsiteProject;
}) {
  const keys = new Set<string>();
  const latest: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const project = websiteProjectFor(message);
    if (project && !keys.has(project.projectKey)) {
      keys.add(project.projectKey);
      latest.push(message);
    }
  }
  if (!latest.length) return null;
  return (
    <section className="website-project-library" aria-label={uiText('workspace:websiteProject')}>
      <p className="section-label">{uiText('workspace:websiteProject')}</p>
      {latest.map((message) => (
        <WebsiteProjectCard key={message.id} message={message} onOpen={onOpen} />
      ))}
    </section>
  );
}

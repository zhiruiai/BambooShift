import type { Message } from '../../../shared/types';
import { formatDate, uiText } from '../i18n';
import type { WebsiteProjectVersion } from '../websiteProjects';

export function websiteDeliveryTime(createdAt: string) {
  return Number.isFinite(Date.parse(createdAt))
    ? formatDate(createdAt, { dateStyle: 'medium', timeStyle: 'medium' })
    : '';
}

export function websiteVersionNumber(
  versions: readonly WebsiteProjectVersion[],
  versionId: string,
) {
  return versions.find(({ project }) => project.id === versionId)?.number;
}

export function WebsiteVersionHistory({
  versions,
  currentId,
  onOpen,
}: {
  versions: WebsiteProjectVersion[];
  currentId: string;
  onOpen: (message: Message) => void;
}) {
  return (
    <ol role="list" aria-label={uiText('workspace:websiteVersionHistory')}>
      {versions.map(({ message, project, number }, index) => {
        const current = project.id === currentId;
        const title = (
          <>
            <strong>{project.title}</strong>
            <span className="website-version-number">
              {uiText('workspace:websiteVersionNumber', { number })}
            </span>
            <time dateTime={message.createdAt}>{websiteDeliveryTime(message.createdAt)}</time>
            {index === 0 && <span>{uiText('workspace:websiteVersionLatest')}</span>}
            {current && <span>{uiText('workspace:websiteVersionCurrent')}</span>}
          </>
        );
        return (
          <li key={project.id}>
            {current ? (
              <div aria-current="true">{title}</div>
            ) : (
              <button type="button" onClick={() => onOpen(message)}>
                {title}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

import { Pencil, X } from 'lucide-react';
import { uiText } from '../i18n';
import type { WebsiteEditContext } from './WorkspaceWebsite';

export function WebsiteComposerContext({ target }: { target: WebsiteEditContext }) {
  const detach = uiText('workspace:websiteComposerDetach');
  return (
    <div className="composer-reply">
      <Pencil size={15} aria-hidden="true" />
      <div className="composer-reply-content" role="status">
        <strong>{uiText('workspace:websiteComposerPrompt', { name: target.title })}</strong>
        {target.version !== undefined && (
          <span>{uiText('workspace:websiteVersionNumber', { number: target.version })}</span>
        )}
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label={detach}
        title={detach}
        onClick={target.cancel}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

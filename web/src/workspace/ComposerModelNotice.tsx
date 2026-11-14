import { ChevronRight, Sparkles } from 'lucide-react';
import { uiText } from '../i18n';

export function ComposerModelNoticeView({
  configured,
  canManage,
  onConfigure,
}: {
  configured: boolean | undefined;
  canManage: boolean;
  onConfigure: () => void;
}) {
  if (configured !== false) return null;
  return canManage ? (
    <button className="setup-note" onClick={onConfigure}>
      <span>
        <Sparkles size={13} />
        {uiText('workspace:text_ba6c7c10cd66')}
      </span>
      <span>
        {uiText('workspace:text_df3d58c7d84b')}
        <ChevronRight size={12} />
      </span>
    </button>
  ) : (
    <div className="setup-note">
      <span>
        <Sparkles size={13} />
        {uiText('workspace:text_4464defc411d')}
      </span>
    </div>
  );
}

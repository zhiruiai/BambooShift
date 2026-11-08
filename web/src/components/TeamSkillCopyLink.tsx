import { Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { teamSkillLinkPath } from '../../../shared/team-skills';
import { uiText } from '../i18n';
import './TeamSkillCopyLink.css';

export function TeamSkillCopyLink({
  teamId,
  publicationId,
  linkId,
  disabled,
}: {
  teamId: string;
  publicationId: string;
  linkId?: string;
  disabled?: boolean;
}) {
  const path = teamSkillLinkPath(teamId, publicationId, linkId);
  return path ? <CopyLink key={path} path={path} disabled={disabled} /> : null;
}

function CopyLink({ path, disabled }: { path: string; disabled?: boolean }) {
  const url = new URL(path, window.location.origin).href;
  const [copied, setCopied] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const manual = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showManual && !disabled) manual.current?.focus();
  }, [showManual, disabled]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setShowManual(false);
    } catch {
      setCopied(false);
      setShowManual(true);
      manual.current?.focus();
      manual.current?.select();
    }
  }

  return (
    <div className="team-skill-copy-link">
      <button className="secondary-button" type="button" disabled={disabled} onClick={copy}>
        <Copy size={14} aria-hidden="true" />
        {uiText('common:teamSkillCopyLink')}
      </button>
      {copied && <span role="status">{uiText('common:teamSkillLinkCopied')}</span>}
      {showManual && !disabled && (
        <label>
          {uiText('common:teamSkillLinkManual')}
          <input
            ref={manual}
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            onCopy={(event) => {
              const input = event.currentTarget;
              if (input.selectionStart === 0 && input.selectionEnd === url.length) setCopied(true);
            }}
          />
        </label>
      )}
    </div>
  );
}

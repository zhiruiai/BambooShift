import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { createAppConnectionScope } from '../appConnections';
import { currentLanguage, uiText } from '../i18n';
import { parseCreationPreview, type CreationPreview } from '../creationPreview';
import { AvatarArtwork } from './AvatarArtwork';
import { GeneratedAvatarArtwork } from './GeneratedAvatarArtwork';
import './CreationBrief.css';

type Props = {
  kind: CreationPreview['kind'];
  active: boolean;
  configured?: boolean;
  workspaceId: string;
  userId: string;
  onUse: (draft: CreationPreview) => void;
};

export function CreationBrief(props: Props) {
  return <ScopedBrief key={`${props.workspaceId}:${props.userId}:${props.kind}`} {...props} />;
}

function ScopedBrief({ kind, active, configured, workspaceId, userId, onUse }: Props) {
  const identity = useRef({ workspaceId, userId });
  identity.current = { workspaceId, userId };
  const visible = useRef(active);
  visible.current = active;
  const [scope] = useState(() =>
    createAppConnectionScope({ workspaceId, userId, identity: () => identity.current }),
  );
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [preview, setPreview] = useState<CreationPreview>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (active && open) scope.resume();
    else {
      inFlight.current = false;
      setBusy(false);
    }
    return () => scope.suspend();
  }, [active, open, scope]);

  async function generate() {
    const ticket = scope.ticket();
    const prompt = brief.trim();
    if (
      !visible.current ||
      !open ||
      !configured ||
      !scope.current(ticket) ||
      !prompt ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    setPreview(undefined);
    try {
      const value = await scope.request<unknown>('/creation-preview', 'POST', {
        kind,
        brief: prompt,
        language: currentLanguage(),
      });
      if (!scope.current(ticket) || !visible.current) return;
      const next = parseCreationPreview(kind, value);
      if (!next) throw new Error('Invalid draft response');
      setPreview(next);
    } catch {
      if (scope.current(ticket) && visible.current) setError(true);
    } finally {
      if (scope.current(ticket)) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <section className="creation-brief">
      <button
        type="button"
        className="secondary-button creation-brief-trigger"
        aria-expanded={open}
        disabled={!active}
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={15} aria-hidden="true" />
        {uiText(kind === 'bot' ? 'bots:smartProfileTitle' : 'bots:smartThemeTitle')}
      </button>
      {open && (
        <div className="creation-brief-body">
          {!configured ? (
            <p>{uiText('bots:smartDraftNeedsModel')}</p>
          ) : (
            <>
              <label>
                <span>
                  {uiText(kind === 'bot' ? 'bots:smartProfileBrief' : 'bots:smartThemeBrief')}
                </span>
                <textarea
                  ref={textarea}
                  rows={3}
                  maxLength={3000}
                  value={brief}
                  disabled={!active || busy}
                  placeholder={uiText(
                    kind === 'bot' ? 'bots:smartProfileExample' : 'bots:smartThemeExample',
                  )}
                  onChange={(event) => {
                    setBrief(event.target.value);
                    setPreview(undefined);
                    setError(false);
                  }}
                />
              </label>
              <div className="creation-brief-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!active || busy || !brief.trim()}
                  onClick={() => void generate()}
                >
                  {busy && <Loader2 size={14} className="spin" aria-hidden="true" />}
                  {uiText(busy ? 'bots:smartDraftBusy' : 'bots:smartDraftGenerate')}
                </button>
                {kind === 'bot' && !brief.trim() && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={!active || busy}
                    onClick={() => {
                      setBrief(uiText('bots:smartThemeDesignerBrief'));
                      textarea.current?.focus();
                    }}
                  >
                    {uiText('bots:smartThemeDesigner')}
                  </button>
                )}
              </div>
              {error && (
                <p role="alert" className="error-text">
                  {uiText('bots:smartDraftError')}
                </p>
              )}
              {preview && (
                <>
                  <CreationDraftSummary draft={preview} />
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!active}
                    onClick={() => {
                      if (!visible.current || !scope.current(scope.ticket())) return;
                      onUse(preview);
                      setPreview(undefined);
                      setOpen(false);
                    }}
                  >
                    {uiText(
                      preview.kind === 'bot' ? 'bots:smartDraftEdit' : 'bots:smartThemeApply',
                    )}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function CreationDraftSummary({ draft }: { draft: CreationPreview }) {
  return draft.kind === 'bot' ? (
    <div className="creation-draft-summary">
      <div className="creation-draft-identity">
        <AvatarArtwork shape={draft.profile.avatar} color={draft.profile.color} size={38} />
        <div>
          <strong>{draft.profile.name}</strong>
          <p>{draft.profile.role}</p>
        </div>
      </div>
      {draft.profile.description && <p>{draft.profile.description}</p>}
    </div>
  ) : (
    <div className="creation-draft-summary">
      <div className="creation-draft-identity">
        <div className="creation-theme-samples">
          {(['orb', 'leaf', 'gem'] as const).map((shape) => (
            <GeneratedAvatarArtwork key={shape} shape={shape} theme={draft.theme} size={38} />
          ))}
        </div>
        <strong>{draft.theme.name}</strong>
      </div>
    </div>
  );
}

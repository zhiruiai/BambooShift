import { uiText } from '../../i18n';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BotTemplate, BotTemplateSummary } from '../../../../shared/bot-templates';
import { botTemplatePath } from '../../../../shared/bot-templates';
import { BotTemplateAvatar } from '../BotTemplatePreview';
import '../BotTemplates.css';
import { Dialog } from '../UI';
import { Common } from './types';
import { StarterTemplateCatalog } from '../StarterTemplateCatalog';
import { StarterTemplateCreate } from './StarterTemplateCreate';
import { SmartTeamPanel } from '../SmartTeamPanel';
import { TeamStarterPicker } from '../team/TeamStarterPicker';
import { useStarterBotInstall } from './useStarterBotInstall';
import type { BotProfileDraft } from '../../botProfiles';
export function TemplateLibrary(props: Common) {
  const [tab, setTab] = useState<'starters' | 'teams' | 'gallery' | 'mine'>('starters'),
    [gallery, setGallery] = useState<BotTemplateSummary[]>([]),
    [mine, setMine] = useState<BotTemplate[]>([]),
    [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [starter, setStarter] = useState<BotProfileDraft>();
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamDirty, setTeamDirty] = useState(false);
  const [leave, setLeave] = useState<() => void>();
  const starterInstall = useStarterBotInstall(props);
  const locked = teamBusy || starterInstall.busy;
  const sequence = useRef(0),
    latest = useRef(props);
  latest.current = props;
  async function read() {
    if (tab === 'starters' || tab === 'teams') return;
    const ticket = props.scope.ticket(),
      order = ++sequence.current;
    if (!props.scope.current(ticket)) return;
    setBusy(true);
    setError('');
    try {
      if (tab === 'mine') {
        const value = await props.scope.request<BotTemplate[]>('/bot-templates');
        if (props.scope.current(ticket) && order === sequence.current) setMine(value);
      } else {
        const response = await fetch('/api/bot-template-gallery', {
          credentials: props.userId ? 'same-origin' : 'omit',
          cache: 'no-store',
          headers: props.userId ? { 'X-OpenBot-Expected-User': props.userId } : undefined,
        });
        if (!response.ok) throw new Error(uiText('common:text_c35c777b5ad6'));
        const value = await response.json();
        if (props.scope.current(ticket) && order === sequence.current)
          setGallery(Array.isArray(value) ? value : value.items || []);
      }
    } catch (cause) {
      if (props.scope.current(ticket) && order === sequence.current)
        setError((cause as Error).message);
    } finally {
      if (props.scope.current(ticket) && order === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!props.owner && tab === 'mine') {
      setMine([]);
      setTab('starters');
      return;
    }
    if (tab === 'gallery' || tab === 'mine') void read();
    else {
      setBusy(false);
      setError('');
    }
    return () => {
      sequence.current++;
    };
  }, [tab, props.scope, props.owner]);
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase());
  const filteredMine = mine.filter((item) =>
    matches(`${item.blueprint.profile.name} ${item.blueprint.profile.role}`),
  );
  const filteredGallery = gallery.filter((item) => matches(`${item.name} ${item.role}`));
  function navigate(action: () => void) {
    if (locked || !props.scope.current(props.scope.ticket())) return;
    if (teamDirty) setLeave(() => action);
    else action();
  }
  function pickTab(next: typeof tab) {
    if (next === tab) return;
    navigate(() => {
      starterInstall.clearError();
      setTab(next);
    });
  }
  if (starter && props.owner)
    return (
      <StarterTemplateCreate
        {...props}
        profile={starter}
        onBack={() => {
          if (props.scope.current(props.scope.ticket())) setStarter(undefined);
        }}
      />
    );
  return (
    <Dialog
      title={uiText('workspace:botGalleryTitle')}
      className="bot-template-dialog"
      onClose={() => navigate(props.onClose)}
    >
      <div className="segmented" role="tablist" aria-label={uiText('common:text_02a897db6c07')}>
        <button
          type="button"
          role="tab"
          disabled={locked}
          aria-selected={tab === 'starters'}
          className={tab === 'starters' ? 'active' : ''}
          onClick={() => pickTab('starters')}
        >
          {uiText('workspace:starterOriginal')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'teams'}
          className={tab === 'teams' ? 'active' : ''}
          disabled={locked}
          onClick={() => pickTab('teams')}
        >
          {uiText('workspace:teamStarterTitle')}
        </button>
        <button
          type="button"
          role="tab"
          disabled={locked}
          aria-selected={tab === 'gallery'}
          className={tab === 'gallery' ? 'active' : ''}
          onClick={() => pickTab('gallery')}
        >
          {uiText('workspace:starterPublished')}
        </button>
        {props.owner && (
          <button
            type="button"
            role="tab"
            disabled={locked}
            aria-selected={tab === 'mine'}
            className={tab === 'mine' ? 'active' : ''}
            onClick={() => {
              if (latest.current.owner) pickTab('mine');
            }}
          >
            {uiText('common:text_65e433b24dab')}
          </button>
        )}
      </div>
      {leave && (
        <div className="bot-form-notice" role="alert">
          <p>{uiText('bots:text_310a2cdc4f6e')}</p>
          <div>
            <button type="button" className="secondary-button" onClick={() => setLeave(undefined)}>
              {uiText('bots:text_fd4b9e3b6c68')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={locked}
              onClick={() => {
                if (!props.scope.current(props.scope.ticket())) return;
                setLeave(undefined);
                setTeamDirty(false);
                leave();
              }}
            >
              {uiText('bots:text_fc0ee8283b68')}
            </button>
          </div>
        </div>
      )}
      {tab === 'starters' ? (
        <StarterTemplateCatalog
          canCreate={props.owner}
          disabled={starterInstall.busy}
          onInstall={starterInstall.install}
          installError={starterInstall.error}
          current={() => props.scope.current(props.scope.ticket())}
          onChoose={(profile) => {
            if (latest.current.owner && props.scope.current(props.scope.ticket()))
              setStarter(structuredClone(profile));
          }}
        />
      ) : tab === 'teams' ? (
        props.owner && props.teamTemplates ? (
          <SmartTeamPanel
            {...props.teamTemplates}
            templatesOnly
            openOnly
            workspaceId={props.workspaceId}
            userId={props.userId}
            onBusy={setTeamBusy}
            onDirty={setTeamDirty}
            onCreated={(plan, _start, confirmed) => {
              if (latest.current.owner && props.scope.current(props.scope.ticket()))
                latest.current.teamTemplates?.onCreated(plan, false, confirmed);
            }}
          />
        ) : (
          <TeamStarterPicker disabled={false} hideHeading />
        )
      ) : (
        <>
          <div className="template-toolbar">
            <input
              aria-label={uiText('common:text_7702a2649c1e')}
              placeholder={uiText('common:text_d27bc73f3285')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void read()}
              aria-label={uiText('common:text_ac4b4541d328')}
            >
              <RefreshCw size={15} className={busy ? 'spin' : ''} />
            </button>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {busy && <p className="field-help">{uiText('common:text_c500eb769b5c')}</p>}
          <div className="template-library-list">
            {tab === 'mine'
              ? filteredMine.map((item) => (
                  <button
                    type="button"
                    className="template-library-row"
                    key={item.id}
                    onClick={() => props.onManage(item.id)}
                  >
                    <BotTemplateAvatar
                      workspaceId={props.workspaceId}
                      userId={props.userId}
                      blueprint={item.blueprint}
                      avatarPath={item.avatarPath}
                      size={38}
                    />
                    <span>
                      <strong>{item.blueprint.profile.name}</strong>
                      <small>
                        {item.blueprint.profile.role} ·{' '}
                        {item.publication
                          ? item.publication.audience === 'public'
                            ? uiText('common:text_cc0b0bca3d60')
                            : uiText('common:text_4e66b24fd230')
                          : uiText('common:text_98d5200f51fa')}
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))
              : filteredGallery.map((item) => (
                  <a
                    className="template-library-row"
                    key={item.token}
                    href={botTemplatePath(item.token)}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      const path = botTemplatePath(item.token);
                      if (path && props.scope.current(props.scope.ticket()))
                        props.onOpenPublic(path);
                    }}
                  >
                    <BotTemplateAvatar
                      summary={item}
                      workspaceId={props.workspaceId}
                      userId={props.userId}
                      size={38}
                    />
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.role} · {item.skillCount}
                        {uiText('common:text_6c0ee356d1c1')}
                        {item.routineCount}
                        {uiText('common:text_32d7a1d43d55')}{' '}
                        {item.audience === 'team'
                          ? uiText('common:text_c161962b0f5f')
                          : uiText('common:text_7a73baf0ce9a')}
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </a>
                ))}
          </div>
          {!busy && (tab === 'mine' ? filteredMine : filteredGallery).length === 0 && (
            <p className="field-help">
              {query.trim()
                ? uiText('common:text_700a7b2ee967')
                : tab === 'mine'
                  ? uiText('common:text_3ffd0a70f5df')
                  : uiText('common:text_ed8634c9c3c9')}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

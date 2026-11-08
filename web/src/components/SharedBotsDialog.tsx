import { uiText } from '../i18n';
import { ArrowRight, Loader2, RefreshCw, Search, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SharedBotCard } from '../../../shared/shared-bots';
import { createSharedBotClient, createSharedBotJoin, type SharedJoinState } from '../sharedBots';
import { Avatar } from './Avatar';
import './SharedBots.css';
import { BrowseProps } from './sharing/types';
import { Dialog } from './UI';
export { ManageSharedBotDialog } from './sharing/ManageSharedBotDialog';
export function SharedBotsDialog(props: BrowseProps) {
  return (
    <SharedBotsContent
      key={`${props.userId}:${props.personalWorkspace?.id || ''}:${props.shareId || ''}`}
      {...props}
    />
  );
}
export function SharedBotsContent(props: BrowseProps) {
  const latest = useRef(props);
  latest.current = props;
  const [client] = useState(() =>
    createSharedBotClient({ userId: props.userId, identity: () => latest.current.userId }),
  );
  const [cards, setCards] = useState<SharedBotCard[]>([]),
    [query, setQuery] = useState(''),
    [teamId, setTeamId] = useState(props.initialTeamId || '');
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [joinState, setJoinState] = useState<SharedJoinState>({ busy: false, error: '' });
  const [joining] = useState(() =>
    props.personalWorkspace
      ? createSharedBotJoin({
          client,
          userId: props.userId,
          workspaceId: props.personalWorkspace.id,
          onChange: setJoinState,
        })
      : undefined,
  );
  const order = useRef(0);
  async function read() {
    const ticket = client.ticket(),
      sequence = ++order.current;
    if (!client.current(ticket)) return;
    setLoading(true);
    setError('');
    try {
      const result = props.shareId
        ? [await client.request<SharedBotCard>(`/shared-bots/${encodeURIComponent(props.shareId)}`)]
        : await client.request<SharedBotCard[]>(
            `/shared-bots?personalWorkspaceId=${encodeURIComponent(props.personalWorkspace?.id || '')}${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ''}`,
          );
      if (client.current(ticket) && sequence === order.current) setCards(result);
    } catch (cause) {
      if (client.current(ticket) && sequence === order.current) setError((cause as Error).message);
    } finally {
      if (client.current(ticket) && sequence === order.current) setLoading(false);
    }
  }
  useEffect(() => {
    client.resume();
    joining?.resume();
    return () => {
      order.current++;
      joining?.suspend();
      client.suspend();
    };
  }, [client, joining]);
  useEffect(() => {
    if (props.personalWorkspace || props.shareId) void read();
    else setLoading(false);
  }, [teamId, props.shareId]);
  const filtered = cards.filter((card) =>
    `${card.name} ${card.role} ${card.description} ${card.ownerName} ${card.teamName}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  function openConfirmed() {
    const confirmed = joining?.state().confirmed;
    if (client.current(client.ticket()) && confirmed) latest.current.onOpen(confirmed);
  }
  return (
    <Dialog
      title={uiText('bots:text_7c5465ff0a82')}
      subtitle={uiText('bots:text_fd1c24ece718')}
      className="shared-bots-dialog"
      onClose={() => {
        if (!joining?.state().busy) props.onClose();
      }}
    >
      <div className="shared-bots-destination">
        <Users size={17} />
        <span>
          {uiText('bots:text_02e813944536')}
          <strong>{props.personalWorkspace?.name || uiText('bots:text_0deb8207a7d8')}</strong>
          <small>{uiText('bots:text_0d3260d72d6e')}</small>
        </span>
      </div>
      {!props.personalWorkspace && <p className="error-text">{uiText('bots:text_a1b31c54e08e')}</p>}
      <div className="shared-bots-filters">
        <label className="shared-bots-search">
          <Search size={16} />
          <input
            aria-label={uiText('bots:text_f3dfdbc36f28')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={uiText('bots:text_35657c1831ee')}
          />
        </label>
        {!props.shareId && (
          <select
            aria-label={uiText('bots:text_6e5e10d1bcff')}
            value={teamId}
            disabled={loading}
            onChange={(e) => setTeamId(e.target.value)}
          >
            <option value="">{uiText('bots:text_90ee5334ec70')}</option>
            {props.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={uiText('bots:text_7f8d4b3f5430')}
          disabled={loading}
          onClick={() => void read()}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {(joinState.pending || joinState.confirmed || joinState.error) && (
        <div className="shared-bot-recovery" role="status">
          <strong>
            {joinState.confirmed
              ? uiText('bots:text_f678b4c00268')
              : joinState.busy
                ? uiText('bots:text_586d2eeb8f12')
                : joinState.pending
                  ? uiText('bots:text_46532a7c3705')
                  : uiText('bots:text_e10ce4b08634')}
          </strong>
          {joinState.error && <p className="error-text">{joinState.error}</p>}
          {joinState.pending && (
            <>
              <p>{uiText('bots:text_988fcd16ffda')}</p>
              <button
                className="secondary-button"
                disabled={joinState.busy}
                onClick={() => void joining?.check()}
              >
                {uiText('bots:text_b5c0aebeddec')}
              </button>
              {joinState.retryAllowed && (
                <button
                  className="secondary-button"
                  disabled={joinState.busy}
                  onClick={() => void joining?.retry()}
                >
                  {uiText('bots:text_8d7d39d122a6')}
                </button>
              )}
            </>
          )}
          {joinState.confirmed && (
            <button className="primary-button" onClick={openConfirmed}>
              {uiText('bots:text_d516af068298')}
              <ArrowRight size={14} />
            </button>
          )}
        </div>
      )}
      {loading && !cards.length ? (
        <p className="section-help">{uiText('bots:text_a14b292c2997')}</p>
      ) : (
        <div className="shared-bot-list">
          {filtered.map((card) => (
            <article className="shared-bot-row" key={card.id}>
              <Avatar
                agent={{
                  ...card,
                  sharedBot: {
                    shareId: card.id,
                    sourceRevision: card.sourceRevision,
                    ownerName: card.ownerName,
                    sourceWorkspaceName: card.sourceWorkspaceName,
                    teamName: card.teamName,
                    status: 'active',
                    avatarPath: card.avatarPath,
                  },
                }}
                userId={props.userId}
                size={48}
              />
              <div className="shared-bot-copy">
                <strong>
                  {card.name}
                  <span className="pill">{uiText('bots:text_7c5465ff0a82')}</span>
                </strong>
                <span>{card.role}</span>
                <p>{card.description || uiText('bots:text_4043e20c5d63')}</p>
                <small>
                  {card.ownerName} · {card.teamName} · {card.skillCount}
                  {uiText('bots:text_e9cd8863984d')} {card.fileCount || 0}
                  {uiText('bots:text_b9326404dda4')}
                  {card.appCount || 0}
                  {uiText('bots:text_c34cdd6848cf')}
                </small>
                <small>{uiText('bots:text_e763e8181d36')}</small>
                <button
                  className="secondary-button"
                  disabled={
                    !props.personalWorkspace ||
                    joinState.busy ||
                    !!joinState.pending ||
                    joinState.recoveryBlocked
                  }
                  onClick={() => void joining?.start(card.id)}
                >
                  {joinState.busy ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <ArrowRight size={14} />
                  )}{' '}
                  {card.joined?.hidden
                    ? uiText('bots:text_288bfbfac211')
                    : card.joined
                      ? uiText('bots:text_43d162e5bd72')
                      : uiText('bots:text_e95d06a95491')}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {!loading && !error && !filtered.length && (
        <p className="section-help">
          {query ? uiText('bots:text_42b692308574') : uiText('bots:text_b63dc302298e')}
        </p>
      )}
    </Dialog>
  );
}

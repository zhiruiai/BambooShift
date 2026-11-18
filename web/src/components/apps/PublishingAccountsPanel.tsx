import { useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';
import type { BotAgent } from '../../../../shared/types';
import type { createAppConnectionScope } from '../../appConnections';
import { uiText } from '../../i18n';
import {
  publishingSites,
  validPublishingAddress,
  type PublishingSite,
} from '../../publishingAccounts';
import './PublishingAccountsPanel.css';

const newSite = 'custom';
function siteName(site: PublishingSite) {
  if (site.name === '知乎') return uiText('apps:publishingZhihu');
  if (site.name === '小红书') return uiText('apps:publishingXiaohongshu');
  return site.name;
}

export type PublishingAccounts = {
  bots: readonly Pick<BotAgent, 'id' | 'name'>[];
  initialBot?: string;
  onOpen: (site: PublishingSite, agentId: string) => void;
};

export function PublishingAccountsPanel({
  bots,
  initialBot,
  onOpen,
  scope,
  team,
  canManage,
}: PublishingAccounts & {
  scope: ReturnType<typeof createAppConnectionScope>;
  team: boolean;
  canManage: boolean;
}) {
  const [sites, setSites] = useState<readonly PublishingSite[]>(publishingSites);
  const [url, setUrl] = useState(publishingSites[0].url);
  const [chosen, setChosen] = useState(initialBot || '');
  const [name, setName] = useState(''),
    [address, setAddress] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const site = sites.find((item) => item.url === url);
  const custom = site && !publishingSites.some((preset) => preset.url === site.url);
  const bot = bots.find((item) => item.id === chosen) || (bots.length === 1 ? bots[0] : undefined);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError('');
    void scope
      .request<PublishingSite[]>('/publishing-sites')
      .then((value) => {
        if (alive) setSites(value);
      })
      .catch((reason: Error) => {
        if (alive) setError(reason.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [scope, revision]);

  async function update(removing: boolean) {
    const ticket = scope.ticket();
    if (!canManage || busy || !scope.current(ticket)) return;
    const target = removing ? site : { name: name.trim(), url: address.trim() };
    if (!target || !target.name || !validPublishingAddress(target.url)) return;
    setBusy(true);
    setError('');
    try {
      const result = await scope.request<PublishingSite[]>(
        '/publishing-sites',
        removing ? 'DELETE' : 'POST',
        target,
      );
      if (!scope.current(ticket)) return;
      setSites(result);
      setUrl(removing ? publishingSites[0].url : new URL(target.url).href);
      setName('');
      setAddress('');
    } catch (reason) {
      if (scope.current(ticket)) setError((reason as Error).message);
    } finally {
      if (scope.current(ticket)) setBusy(false);
    }
  }

  return (
    <section className="apps-scroll publishing-accounts dialog-form">
      <label>
        {uiText('apps:publishingPlatform')}
        <select
          value={url}
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value);
            setError('');
          }}
        >
          {sites.map((item) => (
            <option key={item.url} value={item.url}>
              {siteName(item)}
            </option>
          ))}
          {canManage && <option value={newSite}>{uiText('apps:publishingCustom')}</option>}
        </select>
      </label>
      {url === newSite && canManage ? (
        <form
          className="publishing-custom"
          onSubmit={(e) => {
            e.preventDefault();
            void update(false);
          }}
        >
          <label>
            {uiText('apps:publishingName')}
            <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {uiText('apps:publishingAddress')}
            <input
              required
              type="url"
              placeholder="https://…"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          {address && !validPublishingAddress(address.trim()) && (
            <p className="field-help">{uiText('apps:publishingAddressHelp')}</p>
          )}
          <button
            type="submit"
            className="secondary-button"
            disabled={busy || !name.trim() || !validPublishingAddress(address.trim())}
          >
            {uiText('apps:publishingSave')}
          </button>
        </form>
      ) : (
        site && (
          <>
            <div className="publishing-address">
              <span>{site.url}</span>
              {canManage && custom && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void update(true)}
                >
                  {uiText('apps:publishingRemove')}
                </button>
              )}
            </div>
            <label>
              {uiText('apps:publishingBot')}
              <select
                value={bot?.id || ''}
                onChange={(e) => setChosen(e.target.value)}
                disabled={!bots.length}
              >
                <option value="">{uiText('apps:publishingChooseBot')}</option>
                {bots.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-help">
              {uiText(
                !bots.length
                  ? 'apps:publishingNoBots'
                  : team
                    ? 'apps:publishingTeamProfile'
                    : 'apps:publishingProfile',
              )}
            </p>
            <button
              type="button"
              className="primary-button"
              disabled={!bot || busy}
              onClick={() => bot && onOpen(site, bot.id)}
            >
              <LogIn size={16} aria-hidden="true" />
              {uiText('apps:publishingOpenBrowser')}
            </button>
          </>
        )
      )}
      {error && (
        <div role="alert">
          {error}{' '}
          <button type="button" className="text-button" onClick={() => setRevision((v) => v + 1)}>
            {uiText('apps:text_802a407c7743')}
          </button>
        </div>
      )}
    </section>
  );
}

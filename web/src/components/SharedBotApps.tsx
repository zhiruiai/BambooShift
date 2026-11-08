import { uiText } from '../i18n';
import { Link2, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ConnectedAppTool } from '../../../shared/app-connections';
import { type SharedBotAppView } from '../../../shared/shared-bots';
import { sharedAppStatus } from '../sharedBotApps';
import { createSharedBotClient } from '../sharedBots';
import './SharedBots.css';
import { AppToolDetails } from './sharedApps/AppToolDetails';
import { Props } from './sharedApps/types';
export { AppToolDetails } from './sharedApps/AppToolDetails';
export { SharedBotAppPicker } from './sharedApps/SharedBotAppPicker';
export function SharedBotApps(props: Props) {
  return (
    <SharedBotAppsContent key={`${props.userId}:${props.agent.sharedBot?.shareId}`} {...props} />
  );
}
export function SharedBotAppsContent(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [client] = useState(() =>
    createSharedBotClient({ userId: props.userId, identity: () => latest.current.userId }),
  );
  const [apps, setApps] = useState<SharedBotAppView[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [tools, setTools] = useState<Record<string, ConnectedAppTool[]>>({}),
    [reading, setReading] = useState<string[]>([]);
  const order = useRef(0),
    requests = useRef(new Set<string>()),
    listed = useRef<{ revision?: string; apps: SharedBotAppView[] }>({ apps: [] });
  const endpoint = `/shared-bots/${props.agent.sharedBot!.shareId}/apps`;
  const version = () => latest.current.agent.sharedBot?.appsRevision;
  async function read() {
    const ticket = client.ticket(),
      sequence = ++order.current,
      revision = version();
    if (!client.current(ticket)) return;
    setLoading(true);
    setError('');
    setTools({});
    requests.current.clear();
    setReading([]);
    try {
      const value = await client.request<SharedBotAppView[]>(endpoint);
      if (client.current(ticket) && sequence === order.current && revision === version()) {
        listed.current = { revision, apps: value };
        setApps(value);
      }
    } catch (cause) {
      if (client.current(ticket) && sequence === order.current) {
        setApps([]);
        setError((cause as Error).message);
      }
    } finally {
      if (client.current(ticket) && sequence === order.current) setLoading(false);
    }
  }
  useEffect(() => {
    client.resume();
    return () => {
      order.current++;
      client.suspend();
    };
  }, [client]);
  useEffect(() => {
    client.suspend();
    client.resume();
    setApps([]);
    listed.current = { apps: [] };
    void read();
  }, [
    props.agent.sharedBot?.appsRevision,
    props.agent.sharedBot?.sourceRevision,
    props.agent.sharedBot?.status,
    props.agent.sharedBot?.appCount,
  ]);
  async function inspect(app: SharedBotAppView) {
    const ticket = client.ticket(),
      revision = version(),
      sequence = order.current;
    if (
      !client.current(ticket) ||
      latest.current.agent.sharedBot?.status !== 'active' ||
      listed.current.revision !== revision ||
      !listed.current.apps.some((item) => item === app && item.status === 'available') ||
      requests.current.has(app.connectionId)
    )
      return;
    requests.current.add(app.connectionId);
    setReading([...requests.current]);
    setError('');
    try {
      const value = await client.request<ConnectedAppTool[]>(
        `${endpoint}/${encodeURIComponent(app.connectionId)}/tools`,
      );
      if (client.current(ticket) && sequence === order.current && revision === version())
        setTools((all) => ({ ...all, [app.connectionId]: value }));
    } catch (cause) {
      if (client.current(ticket) && sequence === order.current && revision === version())
        setError((cause as Error).message);
    } finally {
      if (client.current(ticket) && sequence === order.current && revision === version()) {
        requests.current.delete(app.connectionId);
        setReading([...requests.current]);
      }
    }
  }
  return (
    <section className="shared-provided-apps">
      <div className="section-label">
        <span>
          {uiText('apps:text_fef7dca9330a')}
          {props.agent.name}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText('apps:text_ca40e77b3e39', { value0: props.agent.name })}
          disabled={loading}
          onClick={() => void read()}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <p className="field-help">
        {uiText('apps:text_b572ecfa7195')}
        {props.agent.sharedBot?.ownerName || uiText('apps:text_440712bdcd33')}
        {uiText('apps:text_6f8fe2fa321c')}
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {loading && !apps.length && <p className="field-help">{uiText('apps:text_aa1a65dd297a')}</p>}
      {apps.map((app) => (
        <div key={app.connectionId} className="shared-app-row">
          <div className="shared-app-heading">
            <Link2 size={18} />
            <div>
              <strong>{app.name}</strong>
              <small>
                {sharedAppStatus(app)} · {app.tools.length}
                {uiText('apps:text_ca325b8e9f1e')}
              </small>
            </div>
          </div>
          <p className="field-help">
            {app.tools.map((tool) => tool.name).join(uiText('common:punct_c4a40ea8fe35'))}
          </p>
          {app.status === 'available' && (
            <button
              className="text-button"
              type="button"
              disabled={
                reading.includes(app.connectionId) || props.agent.sharedBot?.status !== 'active'
              }
              onClick={() => void inspect(app)}
            >
              {reading.includes(app.connectionId) ? <Loader2 size={14} className="spin" /> : null}
              {uiText('apps:text_9ae8f7e3040d')}
              {app.name}
              {uiText('apps:text_00808d5e5bec')}
            </button>
          )}
          {tools[app.connectionId]?.map((tool) => (
            <AppToolDetails key={tool.name} tool={tool} />
          ))}
        </div>
      ))}
      {!loading && !error && !apps.length && (
        <p className="field-help">{uiText('apps:text_43d2ddc16811')}</p>
      )}
    </section>
  );
}

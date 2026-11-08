import { uiText } from '../../i18n';
import { Link2, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  SHARED_APP_CONNECTIONS,
  SHARED_APP_TOOLS,
  type SharedBotAppCatalog,
  type SharedBotAppGrant,
  type SharedBotAppOptions,
} from '../../../../shared/shared-bots';
import { appConnectionStatus } from '../../appConnections';
import { sharedAppProblem, sharedAppStatus } from '../../sharedBotApps';
import '../SharedBots.css';
import { AppToolDetails } from './AppToolDetails';
import { PickerProps } from './types';
export function SharedBotAppPicker(props: PickerProps) {
  const latest = useRef(props);
  latest.current = props;
  const [options, setOptions] = useState<SharedBotAppOptions>();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [catalogs, setCatalogs] = useState<Record<string, SharedBotAppCatalog>>({});
  const catalogRef = useRef(catalogs);
  catalogRef.current = catalogs;
  const [expanded, setExpanded] = useState<string[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [reading, setReading] = useState<string[]>([]);
  const active = useRef(true),
    order = useRef(0),
    requests = useRef(new Map<string, number>()),
    requestId = useRef(0);
  const current = (ticket: number) => active.current && props.client.current(ticket);
  async function read() {
    const ticket = props.client.ticket(),
      sequence = ++order.current;
    if (!current(ticket)) return;
    setLoading(true);
    setError('');
    try {
      const value = await props.client.request<SharedBotAppOptions>(props.endpoint);
      if (current(ticket) && sequence === order.current) setOptions(value);
    } catch (cause) {
      if (current(ticket) && sequence === order.current) setError((cause as Error).message);
    } finally {
      if (current(ticket) && sequence === order.current) setLoading(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void read();
    return () => {
      active.current = false;
      order.current++;
      requests.current.clear();
      latest.current.onBusy(false);
    };
  }, [props.client, props.endpoint]);
  async function inspect(connectionId: string) {
    const ticket = props.client.ticket();
    if (
      !current(ticket) ||
      latest.current.disabled ||
      requests.current.has(connectionId) ||
      !optionsRef.current?.apps.some(
        (app) => app.connectionId === connectionId && app.status === 'connected',
      )
    )
      return;
    const sequence = ++requestId.current;
    requests.current.set(connectionId, sequence);
    setReading([...requests.current.keys()]);
    latest.current.onBusy(true);
    setError('');
    setExpanded((value) => (value.includes(connectionId) ? value : [...value, connectionId]));
    try {
      const value = await props.client.request<SharedBotAppCatalog>(
        `${props.endpoint}/${encodeURIComponent(connectionId)}`,
      );
      if (current(ticket) && requests.current.get(connectionId) === sequence) {
        if (value.connectionId !== connectionId || !Array.isArray(value.tools))
          throw Error(uiText('apps:text_1f4659eecc12'));
        setCatalogs((all) => ({ ...all, [connectionId]: value }));
      }
    } catch (cause) {
      if (current(ticket) && requests.current.get(connectionId) === sequence)
        setError((cause as Error).message);
    } finally {
      if (current(ticket) && requests.current.get(connectionId) === sequence) {
        requests.current.delete(connectionId);
        setReading([...requests.current.keys()]);
        latest.current.onBusy(requests.current.size > 0);
      }
    }
  }
  function change(apps: SharedBotAppGrant[]) {
    if (!current(props.client.ticket()) || latest.current.disabled) return;
    const problem = sharedAppProblem(apps);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    latest.current.onChange(apps);
  }
  function remove(connectionId: string, name?: string) {
    change(
      latest.current.apps.flatMap((app) =>
        app.connectionId !== connectionId
          ? [app]
          : name
            ? (() => {
                const tools = app.tools.filter((tool) => tool.name !== name);
                return tools.length ? [{ ...app, tools }] : [];
              })()
            : [],
      ),
    );
  }
  function choose(catalog: SharedBotAppCatalog, name: string, checked: boolean) {
    if (
      catalogRef.current[catalog.connectionId] !== catalog ||
      requests.current.has(catalog.connectionId)
    )
      return;
    if (!checked) {
      remove(catalog.connectionId, name);
      return;
    }
    if (
      !optionsRef.current?.apps.some(
        (app) => app.connectionId === catalog.connectionId && app.status === 'connected',
      )
    )
      return;
    const tool = catalog.tools.find((item) => item.name === name),
      chosen = latest.current.apps.find((item) => item.connectionId === catalog.connectionId);
    if (!tool || (chosen && chosen.connectionRevision !== catalog.connectionRevision)) return;
    const grant: SharedBotAppGrant = {
      connectionId: catalog.connectionId,
      name: catalog.name,
      connectionRevision: catalog.connectionRevision,
      tools: [
        ...(chosen?.tools.filter((item) => item.name !== name) || []),
        { name, revision: tool.revision },
      ],
    };
    change([
      ...latest.current.apps.filter((item) => item.connectionId !== catalog.connectionId),
      grant,
    ]);
  }
  function update(catalog: SharedBotAppCatalog) {
    if (
      catalogRef.current[catalog.connectionId] !== catalog ||
      requests.current.has(catalog.connectionId)
    )
      return;
    if (
      !optionsRef.current?.apps.some(
        (app) => app.connectionId === catalog.connectionId && app.status === 'connected',
      )
    )
      return;
    const chosen = latest.current.apps.find((item) => item.connectionId === catalog.connectionId);
    if (
      !chosen ||
      chosen.tools.some((item) => !catalog.tools.some((tool) => tool.name === item.name))
    )
      return;
    change(
      latest.current.apps.map((app) =>
        app !== chosen
          ? app
          : {
              ...app,
              name: catalog.name,
              connectionRevision: catalog.connectionRevision,
              tools: chosen.tools.map((item) => ({
                name: item.name,
                revision: catalog.tools.find((tool) => tool.name === item.name)!.revision,
              })),
            },
      ),
    );
  }
  const rows = [
    ...props.apps,
    ...(options?.apps || []).filter(
      (app) => !props.apps.some((item) => item.connectionId === app.connectionId),
    ),
  ];
  return (
    <section className="shared-app-picker">
      <div className="section-label">
        <span>
          {uiText('apps:text_feb9f91bfd89')}
          {props.apps.length}/{SHARED_APP_CONNECTIONS}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText('apps:text_2f4dde2ad069')}
          disabled={loading || props.disabled}
          onClick={() => void read()}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <p className="field-help">{uiText('apps:text_cd2a03b91847')}</p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {loading && !options ? (
        <p className="field-help">{uiText('apps:text_d5bf3e74fdb1')}</p>
      ) : !rows.length ? (
        <p className="field-help">{uiText('apps:text_636a6dcfe59f')}</p>
      ) : null}
      {rows.map((row) => {
        const chosen = props.apps.find((app) => app.connectionId === row.connectionId),
          candidate = options?.apps.find((app) => app.connectionId === row.connectionId),
          catalog = catalogs[row.connectionId],
          open = expanded.includes(row.connectionId),
          busy = reading.includes(row.connectionId),
          old =
            chosen &&
            catalog &&
            (chosen.connectionRevision !== catalog.connectionRevision ||
              chosen.tools.some(
                (item) =>
                  !catalog.tools.some(
                    (tool) => tool.name === item.name && tool.revision === item.revision,
                  ),
              )),
          missing =
            chosen &&
            catalog &&
            chosen.tools.filter((item) => !catalog.tools.some((tool) => tool.name === item.name)),
          saved = options?.selected.find(
            (app) =>
              app.connectionId === chosen?.connectionId &&
              app.connectionRevision === chosen.connectionRevision &&
              app.tools.length === chosen.tools.length &&
              app.tools.every((tool) =>
                chosen.tools.some(
                  (item) => item.name === tool.name && item.revision === tool.revision,
                ),
              ),
          );
        return (
          <div className="shared-app-row" key={row.connectionId}>
            <div className="shared-app-heading">
              <Link2 size={18} />
              <div>
                <strong>{row.name}</strong>
                <small>
                  {candidate
                    ? appConnectionStatus(candidate.status)
                    : uiText('apps:text_24c89632368f')}
                  {uiText('apps:text_85da02fc14ae')} {chosen?.tools.length || 0}
                  {uiText('apps:text_c36accd31d9e')}
                </small>
              </div>
              <button
                type="button"
                className="text-button"
                disabled={props.disabled || busy || candidate?.status !== 'connected'}
                onClick={() => void inspect(row.connectionId)}
              >
                {busy ? <Loader2 size={14} className="spin" /> : null}
                {open ? uiText('apps:text_6fd87b322eaa') : uiText('apps:text_e2c2f3d5e779')}
              </button>
            </div>
            {saved && saved.status !== 'available' && (
              <p className="field-help">{sharedAppStatus(saved)}</p>
            )}
            {chosen && (
              <div className="shared-app-selected">
                <span>
                  {uiText('apps:text_d4102e5d06a3')}
                  {chosen.tools.map((tool) => tool.name).join(uiText('common:punct_c4a40ea8fe35'))}
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={props.disabled}
                  onClick={() => remove(chosen.connectionId)}
                >
                  {uiText('apps:text_ad605d41acfb')}
                </button>
              </div>
            )}
            {open && catalog && (
              <div className="shared-app-tools">
                {old && (
                  <div className="shared-bot-recovery">
                    <p>{uiText('apps:text_8b7582eebc73')}</p>
                    {missing?.length ? (
                      <>
                        <p>
                          {uiText('apps:text_41c69cd88023')}
                          {missing
                            .map((tool) => tool.name)
                            .join(uiText('common:punct_c4a40ea8fe35'))}
                        </p>
                        {missing.map((tool) => (
                          <button
                            key={tool.name}
                            type="button"
                            className="text-button"
                            disabled={props.disabled || busy}
                            onClick={() => remove(row.connectionId, tool.name)}
                          >
                            {uiText('apps:text_76d7b7320734')}
                            {tool.name}
                          </button>
                        ))}
                      </>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={props.disabled || busy}
                        onClick={() => update(catalog)}
                      >
                        {uiText('apps:text_1102d4072557')}
                      </button>
                    )}
                  </div>
                )}
                {catalog.tools.map((tool) => {
                  const checked = !!chosen?.tools.some((item) => item.name === tool.name);
                  return (
                    <div key={tool.name}>
                      <label className="shared-app-choice">
                        <input
                          type="checkbox"
                          aria-label={uiText('apps:text_a67fa8726736', {
                            value0: row.name,
                            value1: tool.name,
                          })}
                          checked={checked}
                          disabled={
                            props.disabled ||
                            busy ||
                            candidate?.status !== 'connected' ||
                            (!checked &&
                              !!chosen &&
                              chosen.connectionRevision !== catalog.connectionRevision) ||
                            (!checked && (chosen?.tools.length || 0) >= SHARED_APP_TOOLS)
                          }
                          onChange={(event) => choose(catalog, tool.name, event.target.checked)}
                        />
                        <span>{tool.name}</span>
                      </label>
                      <AppToolDetails tool={tool} />
                    </div>
                  );
                })}
                {!catalog.tools.length && (
                  <p className="field-help">{uiText('apps:text_f7d1d8db8b5b')}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="field-help">{uiText('apps:text_4335dca11564')}</p>
    </section>
  );
}

import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Loader2, RefreshCw, Search } from 'lucide-react';
import type {
  SharedBotFileGrant,
  SharedBotFileOptions,
  SharedBotFileView,
} from '../../../shared/shared-bots';
import type { BotAgent } from '../../../shared/types';
import { createSharedBotClient, type SharedBotClient } from '../sharedBots';
import {
  createSharedFileDownload,
  sharedFileProblem,
  sharedFileSize,
  sharedFileStatus,
  validSharedFileGrant,
} from '../sharedBotFiles';
import './SharedBots.css';

type SelectProps = {
  client: SharedBotClient;
  userId: string;
  endpoint: string;
  files: SharedBotFileGrant[];
  disabled: boolean;
  onChange: (files: SharedBotFileGrant[]) => void;
  onBusy: (busy: boolean) => void;
};
export function SharedBotFilePicker(props: SelectProps) {
  const latest = useRef(props);
  latest.current = props;
  const selected = useRef(props.files);
  selected.current = props.files;
  const [options, setOptions] = useState<SharedBotFileOptions>(),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [reading, setReading] = useState<string[]>([]),
    [downloading, setDownloading] = useState('');
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const requests = useRef(new Map<string, number>()),
    downloadBusy = useRef(false),
    sequence = useRef(0),
    readSequence = useRef(0),
    active = useRef(true);
  const [download] = useState(() =>
    createSharedFileDownload({
      client: props.client,
      userId: props.userId,
      basePath: props.endpoint,
    }),
  );
  const current = (ticket: number) => active.current && props.client.current(ticket);
  const busy = () => {
    setReading([...requests.current.keys()]);
    latest.current.onBusy(requests.current.size > 0);
  };
  async function read() {
    const ticket = props.client.ticket(),
      order = ++readSequence.current;
    if (!current(ticket)) return;
    setLoading(true);
    setError('');
    try {
      const value = await props.client.request<SharedBotFileOptions>(
        `${props.endpoint}${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ''}`,
      );
      if (current(ticket) && order === readSequence.current) setOptions(value);
    } catch (cause) {
      if (current(ticket) && order === readSequence.current) setError((cause as Error).message);
    } finally {
      if (current(ticket) && order === readSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    active.current = true;
    download.resume();
    return () => {
      active.current = false;
      readSequence.current++;
      requests.current.clear();
      download.suspend();
      latest.current.onBusy(false);
    };
  }, [download]);
  useEffect(() => {
    if (!query) void read();
    else {
      const timer = setTimeout(() => void read(), 250);
      return () => {
        clearTimeout(timer);
        readSequence.current++;
      };
    }
  }, [query]);
  function remove(fileId: string) {
    if (latest.current.disabled || !current(props.client.ticket())) return;
    requests.current.delete(fileId);
    busy();
    selected.current = selected.current.filter((file) => file.fileId !== fileId);
    latest.current.onChange(selected.current);
  }
  async function select(fileId: string) {
    const ticket = props.client.ticket();
    if (latest.current.disabled || !current(ticket) || requests.current.has(fileId)) return;
    const order = ++sequence.current;
    requests.current.set(fileId, order);
    busy();
    setError('');
    try {
      const grant = await props.client.request<SharedBotFileGrant>(
        `${props.endpoint}/${encodeURIComponent(fileId)}`,
      );
      if (!current(ticket) || requests.current.get(fileId) !== order || latest.current.disabled)
        return;
      if (!validSharedFileGrant(grant) || grant.fileId !== fileId)
        throw new Error(uiText('bots:text_7853883c3462'));
      const next = [...selected.current.filter((file) => file.fileId !== fileId), grant],
        problem = sharedFileProblem(next);
      if (problem) throw new Error(problem);
      selected.current = next;
      latest.current.onChange(next);
    } catch (cause) {
      if (current(ticket) && requests.current.get(fileId) === order)
        setError((cause as Error).message);
    } finally {
      if (requests.current.get(fileId) === order) {
        requests.current.delete(fileId);
        if (current(ticket)) busy();
      }
    }
  }
  async function saveFile(file: SharedBotFileGrant) {
    const ticket = props.client.ticket();
    if (!current(ticket) || downloadBusy.current) return;
    downloadBusy.current = true;
    setDownloading(file.fileId);
    setError('');
    try {
      await download.download(file);
    } catch (cause) {
      if (current(ticket)) setError((cause as Error).message);
    } finally {
      downloadBusy.current = false;
      if (current(ticket)) setDownloading('');
    }
  }
  const candidates = options?.files || [],
    rows = [
      ...props.files,
      ...candidates.filter((file) => !props.files.some((chosen) => chosen.fileId === file.fileId)),
    ];
  return (
    <section className="shared-file-picker">
      <div className="section-label">
        <span>
          {uiText('bots:text_cf5cf74ecaa3')}
          {props.files.length}/32
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText('bots:text_17d62d2a49e1')}
          disabled={loading || props.disabled}
          onClick={() => void read()}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <p className="field-help">{uiText('bots:text_439118b3fefc')}</p>
      <label className="shared-file-search">
        <Search size={15} />
        <input
          aria-label={uiText('bots:text_29cd4e7ea766')}
          placeholder={uiText('bots:text_3eb762c54368')}
          maxLength={120}
          value={query}
          onChange={(event) => {
            const next = event.target.value.slice(0, 120);
            if (next === latestQuery.current) return;
            readSequence.current++;
            setLoading(true);
            setQuery(next);
          }}
        />
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {loading && !options ? (
        <p className="field-help">{uiText('bots:text_fefb31a4b4e0')}</p>
      ) : (
        <div className="shared-file-list">
          {rows.map((file) => {
            const chosen = props.files.find((item) => item.fileId === file.fileId),
              waiting = reading.includes(file.fileId),
              status =
                chosen &&
                options?.selected?.find(
                  (item) => item.fileId === chosen.fileId && item.revision === chosen.revision,
                );
            return (
              <div className="shared-file-row" key={file.fileId}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={uiText('bots:text_f78688618d6b', { value0: file.name })}
                    checked={!!chosen || waiting}
                    disabled={
                      props.disabled || (!chosen && !waiting && file.size > 10 * 1024 * 1024)
                    }
                    onChange={(event) =>
                      event.target.checked ? void select(file.fileId) : remove(file.fileId)
                    }
                  />
                  <span className="file-icon">
                    <FileText size={18} />
                  </span>
                  <span className="file-copy">
                    <strong>{file.name}</strong>
                    <small>
                      {sharedFileSize(file.size)}
                      {chosen ? uiText('bots:text_9fa208c2e672') : ''}
                      {file.size > 10 * 1024 * 1024 ? uiText('bots:text_0175bd3964a8') : ''}
                    </small>
                    {status && status.status !== 'available' && (
                      <small className="error-text">{sharedFileStatus(status)}</small>
                    )}
                  </span>
                  {waiting && <Loader2 size={14} className="spin" />}
                </label>
                {chosen && !waiting && (
                  <div className="shared-file-actions">
                    {(!status || status.status === 'available') && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={!!downloading || props.disabled}
                        onClick={() => void saveFile(chosen)}
                      >
                        <Download size={13} />
                        {uiText('bots:text_51683afa4880')}
                      </button>
                    )}
                    {(status?.status === 'changed' || status?.status === 'unavailable') && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={props.disabled}
                        onClick={() => void select(file.fileId)}
                      >
                        {uiText('bots:text_223220a95563')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!loading && !rows.length && (
        <p className="field-help">
          {query ? uiText('bots:text_1623879717de') : uiText('bots:text_efcf7d8375aa')}
        </p>
      )}
      {options?.truncated && <p className="field-help">{uiText('bots:text_0da5a62d4a5d')}</p>}
      <p className="field-help">
        {uiText('bots:text_52c963128eab')}
        {props.files.length}
        {uiText('bots:text_21a7db632025')}{' '}
        {sharedFileSize(props.files.reduce((sum, file) => sum + file.size, 0))}
        {uiText('bots:text_67a58a2eca55')}
      </p>
    </section>
  );
}

type FilesProps = { agent: BotAgent; userId: string };
export function SharedBotFiles(props: FilesProps) {
  return (
    <SharedBotFilesContent key={`${props.userId}:${props.agent.sharedBot?.shareId}`} {...props} />
  );
}
function SharedBotFilesContent(props: FilesProps) {
  const latest = useRef(props);
  latest.current = props;
  const [client] = useState(() =>
    createSharedBotClient({ userId: props.userId, identity: () => latest.current.userId }),
  );
  const endpoint = `/shared-bots/${props.agent.sharedBot!.shareId}/files`;
  const [download] = useState(() =>
    createSharedFileDownload({
      client,
      userId: props.userId,
      basePath: endpoint,
      allowed: () => latest.current.agent.sharedBot?.status === 'active',
      version: () => latest.current.agent.sharedBot?.filesRevision,
    }),
  );
  const [files, setFiles] = useState<SharedBotFileView[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [downloading, setDownloading] = useState('');
  const order = useRef(0),
    busy = useRef(false),
    downloadEpoch = useRef(0);
  const listed = useRef<{ revision?: string; files: SharedBotFileView[] }>({ files: [] });
  async function read() {
    const ticket = client.ticket(),
      request = ++order.current,
      revision = latest.current.agent.sharedBot?.filesRevision;
    if (!client.current(ticket)) return;
    setLoading(true);
    setError('');
    try {
      const value = await client.request<SharedBotFileView[]>(endpoint);
      if (
        client.current(ticket) &&
        request === order.current &&
        revision === latest.current.agent.sharedBot?.filesRevision
      ) {
        listed.current = { revision, files: value };
        setFiles(value);
      }
    } catch (cause) {
      if (client.current(ticket) && request === order.current) {
        setFiles([]);
        setError((cause as Error).message);
      }
    } finally {
      if (client.current(ticket) && request === order.current) setLoading(false);
    }
  }
  useEffect(() => {
    client.resume();
    download.resume();
    return () => {
      order.current++;
      client.suspend();
      download.suspend();
    };
  }, [client, download]);
  useEffect(() => {
    downloadEpoch.current++;
    download.suspend();
    download.resume();
    busy.current = false;
    setDownloading('');
    setFiles([]);
  }, [download, props.agent.sharedBot?.filesRevision, props.agent.sharedBot?.status]);
  useEffect(() => {
    void read();
  }, [
    props.agent.sharedBot?.sourceRevision,
    props.agent.sharedBot?.status,
    props.agent.sharedBot?.fileCount,
    props.agent.sharedBot?.filesRevision,
  ]);
  async function saveFile(file: SharedBotFileView) {
    const ticket = client.ticket(),
      epoch = downloadEpoch.current;
    if (
      !client.current(ticket) ||
      busy.current ||
      listed.current.revision !== latest.current.agent.sharedBot?.filesRevision ||
      !listed.current.files.some(
        (current) =>
          current.fileId === file.fileId &&
          current.revision === file.revision &&
          current.status === 'available',
      ) ||
      file.status !== 'available' ||
      latest.current.agent.sharedBot?.status !== 'active'
    )
      return;
    busy.current = true;
    setDownloading(file.fileId);
    setError('');
    try {
      await download.download(file);
    } catch (cause) {
      if (client.current(ticket) && epoch === downloadEpoch.current)
        setError((cause as Error).message);
    } finally {
      if (epoch === downloadEpoch.current) {
        busy.current = false;
        if (client.current(ticket)) setDownloading('');
      }
    }
  }
  return (
    <section className="shared-provided-files">
      <div className="section-label">
        <span>
          {uiText('bots:text_fef7dca9330a')}
          {props.agent.name}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText('bots:text_b5a102a5ea15', { value0: props.agent.name })}
          disabled={loading}
          onClick={() => void read()}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <p className="field-help">
        {uiText('bots:text_df6e36f75c22')}
        {props.agent.sharedBot?.ownerName || uiText('bots:text_440712bdcd33')}
        {uiText('bots:text_18b70f4659eb')}
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {loading && !files.length ? (
        <p className="field-help">{uiText('bots:text_51409e6b48e5')}</p>
      ) : (
        files.map((file) => (
          <div className="shared-file-row" key={file.fileId}>
            <div className="shared-file-description">
              <span className="file-icon">
                <FileText size={18} />
              </span>
              <span className="file-copy">
                <strong>{file.name}</strong>
                <small>
                  {sharedFileSize(file.size)} · {sharedFileStatus(file)}
                </small>
              </span>
            </div>
            {file.status === 'available' && (
              <button
                type="button"
                className="text-button"
                disabled={!!downloading || props.agent.sharedBot?.status !== 'active'}
                onClick={() => void saveFile(file)}
              >
                {downloading === file.fileId ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <Download size={13} />
                )}
                {uiText('bots:text_abbb45347699')}
              </button>
            )}
          </div>
        ))
      )}
      {!loading && !error && !files.length && (
        <p className="field-help">{uiText('bots:text_5f8d281ebef3')}</p>
      )}
    </section>
  );
}

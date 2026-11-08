import { uiText } from '../../../web/src/i18n';
import { Building2, Loader2, Pause, Play, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PlatformPage, PlatformUser, PlatformWorkspace } from '../../../shared/platform';
import '../../../web/src/admin/Admin.css';
import { AccountInitial } from '../../../web/src/platform/account/AccountInitial';
import '../../../web/src/platform/Platform.css';
import { platformTime } from '../../../web/src/platform/platformApi';
import { useOperatorScope } from './useOperatorScope';
import { Status } from './Status';
import { StatusTarget } from './types';
export function PlatformDirectory({
  kind,
  revision,
  currentUserId,
  busy,
  onChangeStatus,
}: {
  kind: 'users' | 'workspaces';
  revision: number;
  currentUserId?: string;
  busy: boolean;
  onChangeStatus: (target: StatusTarget) => void;
}) {
  const scope = useOperatorScope(currentUserId);
  const [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1);
  const [result, setResult] = useState<PlatformPage<PlatformUser | PlatformWorkspace> | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    void scope
      .request<PlatformPage<PlatformUser | PlatformWorkspace>>(
        `/platform/${kind}?${new URLSearchParams({ page: String(page), q: query })}`,
      )
      .then((value) => {
        if (request === sequence.current) setResult(value);
      })
      .catch((cause) => {
        if (request === sequence.current) setError((cause as Error).message);
      })
      .finally(() => {
        if (request === sequence.current) setLoading(false);
      });
    return () => {
      sequence.current++;
    };
  }, [kind, query, page, revision, retry, scope]);
  const pages = result ? Math.max(1, Math.ceil(result.total / Math.max(1, result.pageSize))) : 1;
  return (
    <>
      <div className="admin-page-heading">
        <h2>
          {kind === 'users'
            ? uiText('platform:text_fbf413d429bd')
            : uiText('platform:text_b562d9db1560')}
        </h2>
        <p>
          {kind === 'users'
            ? uiText('platform:text_05248effdd9e')
            : uiText('platform:text_9c098b026132')}
        </p>
      </div>
      <form
        className="admin-section-tools"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
          setPage(1);
          setRetry((value) => value + 1);
        }}
      >
        <label>
          <Search size={16} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              kind === 'users'
                ? uiText('platform:text_199a8b003f30')
                : uiText('platform:text_1339ed2c430e')
            }
            aria-label={
              kind === 'users'
                ? uiText('platform:text_62eb3f931b9a')
                : uiText('platform:text_8316f0e7e566')
            }
            maxLength={100}
          />
        </label>
        <button className="secondary-button" disabled={loading}>
          {uiText('platform:text_44ce7ae909bb')}
        </button>
      </form>
      {error && (
        <div className="platform-error" role="alert">
          {error}
          <button
            className="platform-text-button"
            type="button"
            disabled={loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            {uiText('platform:text_b8784c8dd563')}
          </button>
        </div>
      )}
      <section className="admin-card">
        {loading ? (
          <div className="platform-loading">
            <Loader2 className="spin" size={20} />
            <p>{uiText('platform:text_db97b49f491d')}</p>
          </div>
        ) : result && !error ? (
          <>
            {result.items.length ? (
              <div
                className="admin-table-wrap"
                tabIndex={0}
                role="region"
                aria-label={
                  kind === 'users'
                    ? uiText('platform:text_2d0b02c493f1')
                    : uiText('platform:text_b6dd16fd077f')
                }
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">
                        {kind === 'users'
                          ? uiText('platform:text_0d0e1a86b3aa')
                          : uiText('platform:text_3347e052c0f1')}
                      </th>
                      <th scope="col">
                        {kind === 'users'
                          ? uiText('platform:text_73075237fd0f')
                          : uiText('platform:text_c4cb31fec327')}
                      </th>
                      <th scope="col">{uiText('platform:text_6320b4a8722a')}</th>
                      <th scope="col">{uiText('platform:text_07ec86e0f1d4')}</th>
                      <th scope="col">{uiText('platform:text_ed31fbb483ee')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((item) => {
                      const user = 'email' in item;
                      const current = user && item.id === currentUserId;
                      return (
                        <tr key={item.id}>
                          <td>
                            <div className="platform-user-name">
                              {user ? <AccountInitial name={item.name} /> : <Building2 size={20} />}
                              <div>
                                <strong>{item.name}</strong>
                                {!user && (
                                  <small>
                                    {item.kind === 'team'
                                      ? uiText('platform:text_2714df648cbd')
                                      : uiText('platform:text_51fcaa8035fc')}
                                  </small>
                                )}
                              </div>
                            </div>
                          </td>
                          <td>
                            {user ? (
                              item.email
                            ) : (
                              <>
                                {item.ownerName}
                                <small>
                                  {item.memberCount}
                                  {uiText('platform:text_e0c44489ceaf')}
                                </small>
                              </>
                            )}
                          </td>
                          <td>
                            <Status value={item.status} />
                          </td>
                          <td>{platformTime(item.createdAt)}</td>
                          <td>
                            {current ? (
                              <span className="field-help">
                                {uiText('platform:text_e8f0d7dc1ffd')}
                              </span>
                            ) : (
                              <button
                                className="secondary-button"
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  onChangeStatus({
                                    kind,
                                    id: item.id,
                                    name: item.name,
                                    status: item.status,
                                  })
                                }
                              >
                                {item.status === 'active' ? (
                                  <Pause size={13} />
                                ) : (
                                  <Play size={13} />
                                )}
                                {item.status === 'active'
                                  ? uiText('platform:text_4e6fd0e28c55')
                                  : uiText('platform:text_e0534b8a4e46')}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="platform-empty">
                {uiText('platform:text_a22907f1e5f0')}
                {kind === 'users'
                  ? uiText('platform:text_0d0e1a86b3aa')
                  : uiText('platform:text_3347e052c0f1')}
                {uiText('common:punct_eb0d5884569b')}
              </p>
            )}
            <div className="platform-pagination">
              <span>
                {uiText('platform:text_2428420e407f')}
                {result.total}
                {uiText('platform:text_f81a1e9119a8')}
                {result.page} / {pages}
                {uiText('platform:text_85ca81cf6abd')}
              </span>
              <div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || result.page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  {uiText('platform:text_c9b9ae7a6144')}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || result.page >= pages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  {uiText('platform:text_8a8542f69648')}
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="platform-empty">{uiText('platform:text_bdb56e1a1355')}</p>
        )}
      </section>
    </>
  );
}

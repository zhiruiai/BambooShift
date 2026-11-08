import { uiText } from '../../../web/src/i18n';
import { ArrowUpRight, Building2, LayoutGrid, Pause, Users } from 'lucide-react';
import type { PlatformOverview } from '../../../shared/platform';
import '../../../web/src/admin/Admin.css';
import { AccountInitial } from '../../../web/src/platform/account/AccountInitial';
import '../../../web/src/platform/Platform.css';
import { platformTime } from '../../../web/src/platform/platformApi';
import { Status } from './Status';
import { View } from './types';
export function PlatformOverviewPanel({
  overview,
  onView,
}: {
  overview: PlatformOverview;
  onView: (view: View) => void;
}) {
  const stats = [
    {
      label: uiText('platform:text_f36e03a27ae0'),
      value: overview.counts.users,
      detail: uiText('platform:text_3fc9c26f9b56', {
        value0: overview.counts.activeUsers,
        value1: overview.counts.suspendedUsers,
      }),
      view: 'users' as const,
      icon: Users,
    },
    {
      label: uiText('platform:text_2714df648cbd'),
      value: overview.counts.teams,
      detail: uiText('platform:text_717ba0003f7d'),
      view: 'workspaces' as const,
      icon: Building2,
    },
    {
      label: uiText('platform:text_51fcaa8035fc'),
      value: overview.counts.personalWorkspaces,
      detail: uiText('platform:text_356a3d356474'),
      view: 'workspaces' as const,
      icon: LayoutGrid,
    },
    {
      label: uiText('platform:text_968c7b1ecb96'),
      value: overview.counts.suspendedWorkspaces,
      detail: uiText('platform:text_1ca727787722'),
      view: 'workspaces' as const,
      icon: Pause,
    },
  ];
  return (
    <>
      <div className="admin-page-heading">
        <h2>{uiText('platform:text_616c512c1311')}</h2>
        <p>{uiText('platform:text_b3b183afaded')}</p>
      </div>
      <div className="admin-stats">
        {stats.map((item) => (
          <button
            key={item.label}
            type="button"
            className="admin-stat"
            onClick={() => onView(item.view)}
          >
            <span className="admin-stat-icon">
              <item.icon size={18} />
            </span>
            <span className="admin-stat-label">{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.detail}</small>
          </button>
        ))}
      </div>
      <div className="admin-grid">
        <section className="admin-card">
          <div className="admin-card-heading">
            <h3>{uiText('platform:text_1ae87d078c06')}</h3>
            <button className="admin-plain-link" type="button" onClick={() => onView('users')}>
              {uiText('platform:text_61e865c7de0a')}
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="admin-list">
            {overview.recentUsers.length ? (
              overview.recentUsers.map((user) => (
                <div className="admin-row" key={user.id}>
                  <AccountInitial name={user.name} />
                  <div className="admin-row-copy">
                    <strong>{user.name}</strong>
                    <small>{user.email}</small>
                    <small>{platformTime(user.createdAt)}</small>
                  </div>
                  <Status value={user.status} />
                </div>
              ))
            ) : (
              <p className="platform-empty">{uiText('platform:text_90e0fbaa9849')}</p>
            )}
          </div>
        </section>
        <section className="admin-card">
          <div className="admin-card-heading">
            <h3>{uiText('platform:text_8e185edd5bf3')}</h3>
            <button className="admin-plain-link" type="button" onClick={() => onView('workspaces')}>
              {uiText('platform:text_738671a5cfe9')}
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="admin-list">
            {overview.recentWorkspaces.length ? (
              overview.recentWorkspaces.map((workspace) => (
                <div className="admin-row" key={workspace.id}>
                  <Building2 size={20} />
                  <div className="admin-row-copy">
                    <strong>{workspace.name}</strong>
                    <small>
                      {workspace.kind === 'team'
                        ? uiText('platform:text_acdf17f4e9c4')
                        : uiText('platform:text_15dec507959e')}{' '}
                      · {workspace.ownerName} · {workspace.memberCount}
                      {uiText('platform:text_e0c44489ceaf')}
                    </small>
                    <small>{platformTime(workspace.createdAt)}</small>
                  </div>
                  <Status value={workspace.status} />
                </div>
              ))
            ) : (
              <p className="platform-empty">{uiText('platform:text_4f7a981ca7fa')}</p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

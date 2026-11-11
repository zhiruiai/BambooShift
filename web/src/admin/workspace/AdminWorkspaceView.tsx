import { uiText } from '../../i18n';
import { ArrowLeft, ArrowUpRight, Loader2, RefreshCw, X } from 'lucide-react';
import { routineConfigSnapshot } from '../../../../shared/routine-operations';
import { isSharedBot } from '../../../../shared/shared-bots';
import type { Bootstrap } from '../../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { ComputerDialog } from '../../components/ComputerDialog';
import { Markdown } from '../../components/Markdown';
import { RoutineDialog } from '../../components/RoutineDialog';
import { SettingsDialog } from '../../components/SettingsDialog';
import { SkillVersionReview } from '../../components/SkillVersionReview';
import { Dialog, IconButton } from '../../components/UI';
import { AccountMenu } from '../../platform/AccountAccess';
import { routineOperationDestination } from '../../routineOperationNavigation';
import { currentSkillVersion } from '../../skillVersions';
import { currentWorkspaceId, workspaceUrl } from '../../workspace-scope';
import '../Admin.css';
import { AdminEmpty, AdminStatus, adminTime } from '../AdminPanels';
import { sections } from './parts';
import type { useAdminWorkspace } from './useAdminWorkspace';
export type AdminWorkspaceModel = ReturnType<typeof useAdminWorkspace>;
export function AdminWorkspaceView(model: AdminWorkspaceModel) {
  const {
    view,
    selectView,
    account,
    activeSection,
    overview,
    online,
    refreshing,
    refresh,
    loadError,
    data,
    actionError,
    setActionError,
    panelProps,
    Panel,
    notice,
    modal,
    setModal,
    setData,
    setOverview,
    computerAgentId,
    setComputerAgentId,
    conversationId,
    busy,
    action,
    identity,
    scope,
    mounted,
    routineConversation,
    saveRoutine,
    skill,
    actionRunning,
    setBusy,
    setNotice,
  } = model;
  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <a
          className="admin-brand"
          href={workspaceUrl('/manage')}
          aria-label={uiText('platform:text_e2825a06f418')}
        >
          <Avatar size={35} />
          <span>
            <strong>MosoCrew</strong>
            <small>{uiText('platform:text_c6bdf6d83d2c')}</small>
          </span>
        </a>
        <nav className="admin-nav" aria-label={uiText('platform:text_275165f49b71')}>
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                type="button"
                key={section.id}
                className={view === section.id ? 'active' : ''}
                aria-current={view === section.id ? 'page' : undefined}
                onClick={() => selectView(section.id)}
              >
                <Icon size={18} />
                <span>{section.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="admin-sidebar-footer">
          {account && (
            <AccountMenu session={account.session} activeWorkspaceId={account.workspace.id} />
          )}
          <a href={workspaceUrl('/')} className="admin-plain-link">
            <ArrowLeft size={15} />
            {uiText('platform:text_0a7576b364ac')}
          </a>
          <small>{uiText('platform:text_1d6e0bda8e27')}</small>
        </div>
      </aside>
      <section className="admin-main" aria-label={activeSection.label}>
        <header className="admin-topbar">
          <div>
            <h1>{activeSection.label}</h1>
            <p>
              {overview
                ? uiText('platform:text_e0889dd98714', { value0: adminTime(overview.generatedAt) })
                : uiText('platform:text_e40765dfdb43')}
            </p>
          </div>
          <div className="admin-topbar-actions">
            <AdminStatus tone={online ? '' : 'waiting'}>
              {online ? uiText('platform:text_6128c668bf19') : uiText('platform:text_360f969c99aa')}
            </AdminStatus>
            <button
              className="secondary-button"
              type="button"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              {uiText('platform:text_aee887434131')}
            </button>
            <a href={workspaceUrl('/')} className="secondary-button">
              <ArrowUpRight size={14} />
              {uiText('platform:text_21164f32c01e')}
            </a>
          </div>
        </header>
        <div className="admin-content">
          {loadError && (
            <div className="admin-alert" role="alert">
              <span>
                {data ? uiText('platform:text_fef717d91b83') : uiText('platform:text_f0bc9f50e3ff')}{' '}
                {loadError}
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                {uiText('platform:text_b8784c8dd563')}
              </button>
            </div>
          )}
          {!online && data && (
            <div className="admin-alert" role="status">
              {uiText('platform:text_dfa0287ad979')}
            </div>
          )}
          {actionError && (
            <div className="admin-alert" role="alert">
              <span>{actionError}</span>
              <IconButton
                label={uiText('platform:text_1ae440224dab')}
                onClick={() => setActionError('')}
              >
                <X size={16} />
              </IconButton>
            </div>
          )}
          {panelProps ? (
            <Panel {...panelProps} />
          ) : refreshing ? (
            <div className="admin-loading">
              <Avatar size={56} />
              <Loader2 className="spin" size={18} />
              <p>{uiText('platform:text_a4e0e372673b')}</p>
            </div>
          ) : (
            <AdminEmpty detail={uiText('platform:text_4914c4392a3f')}>
              {uiText('platform:text_5bc783b741de')}
            </AdminEmpty>
          )}
        </div>
      </section>
      {(notice || (modal && actionError)) && (
        <div className="admin-toast" role={modal && actionError ? 'alert' : 'status'}>
          {modal && actionError ? (
            <>
              <span>{actionError}</span>
              <button
                className="admin-toast-dismiss"
                type="button"
                onClick={() => setActionError('')}
              >
                {uiText('platform:text_3fd47edce45b')}
              </button>
            </>
          ) : (
            notice
          )}
        </div>
      )}
      {data && modal?.kind === 'settings' && (
        <SettingsDialog
          settings={data.settings}
          onClose={() => setModal(null)}
          onSettingsChanged={(settings) => {
            setData((previous) => (previous ? { ...previous, settings } : previous));
            setOverview((previous) => (previous ? { ...previous, settings } : previous));
            void refresh();
          }}
        />
      )}
      {data && modal?.kind === 'computer' && (
        <ComputerDialog
          key={`${account?.session.user?.id ?? ''}:${account?.workspace.id ?? currentWorkspaceId() ?? ''}:${computerAgentId ?? ''}`}
          data={data}
          agentId={computerAgentId}
          onSelectBot={setComputerAgentId}
          conversationId={conversationId}
          conversationTitle={
            data.conversations.find((item) => item.id === conversationId)?.title ||
            uiText('platform:text_34c2262f8012')
          }
          busy={busy}
          onClose={() => setModal(null)}
          onAction={action}
          refresh={refresh}
        />
      )}
      {data && modal?.kind === 'routine' && (
        <RoutineDialog
          canManagePublicSearch={account?.workspace.role === 'owner'}
          canManageWebhooks={account?.workspace.role === 'owner'}
          workspaceId={identity.current.workspaceId}
          userId={identity.current.userId}
          onChanged={async (receipt) => {
            if (
              !scope.current(scope.ticket()) ||
              receipt.userId !== identity.current.userId ||
              receipt.workspaceId !== identity.current.workspaceId
            )
              return;
            await refresh();
          }}
          onOpenConversation={async (receipt) => {
            const ticket = scope.ticket();
            if (
              !scope.current(ticket) ||
              receipt.userId !== identity.current.userId ||
              receipt.workspaceId !== identity.current.workspaceId
            )
              throw Error(uiText('platform:text_ce2d9676298e'));
            const snapshot = await scope.request<Bootstrap>('/bootstrap');
            if (!scope.current(ticket) || !mounted.current)
              throw Error(uiText('platform:text_ce2d9676298e'));
            const destination = routineOperationDestination(snapshot, receipt);
            const root = receipt.workspaceId
              ? `/w/${encodeURIComponent(receipt.workspaceId)}/`
              : '/';
            window.location.assign(
              `${root}?conversation=${encodeURIComponent(destination.id)}${receipt.kind === 'run' ? '&message=' + encodeURIComponent(receipt.messageId) : ''}`,
            );
          }}
          agents={data.agents.filter((agent) => routineConversation?.agentIds.includes(agent.id))}
          allAgents={data.agents}
          conversations={data.conversations}
          routines={data.routines}
          conversationId={modal.conversationId}
          initialRoutineId={modal.routineId}
          defaultTimeZone={data.workspaceTimeZone?.timeZone}
          busy={busy}
          onClose={() => setModal(null)}
          onSave={saveRoutine}
          onToggle={(routine) =>
            action(() =>
              scope.request(`/routines/${encodeURIComponent(routine.id)}`, 'PATCH', {
                enabled: !routine.enabled,
              }),
            )
          }
          onDelete={(routine) =>
            action(
              () =>
                scope.request(`/routines/${encodeURIComponent(routine.id)}`, 'DELETE', {
                  expectedRoutine: routineConfigSnapshot(routine),
                }),
              uiText('platform:text_f3f4076fb87c'),
            )
          }
        />
      )}
      {modal?.kind === 'skill' && (
        <Dialog
          title={skill?.name || uiText('platform:text_8595b4fe3c48')}
          subtitle={
            skill
              ? uiText('platform:text_2621513fd74e', {
                  value0:
                    data?.agents.find((agent) => agent.id === skill.agentId)?.name ||
                    uiText('platform:text_0583e9855b7b'),
                  value1: skill.version,
                })
              : undefined
          }
          onClose={() => {
            if (!actionRunning.current) setModal(null);
          }}
          className="admin-dialog"
        >
          {skill && isSharedBot(data?.agents.find((agent) => agent.id === skill.agentId)) ? (
            <>
              <p className="field-help">{uiText('platform:text_b67fa2b0d729')}</p>
              <div className="skill-content">
                <Markdown text={skill.content} />
              </div>
            </>
          ) : skill ? (
            <SkillVersionReview
              key={skill.id}
              skill={skill}
              current={currentSkillVersion(data?.skills || [], skill)}
              busy={busy}
              onBack={() => setModal(null)}
              onApply={async (transition, expectedActiveId) => {
                if (actionRunning.current)
                  return { ok: false, error: uiText('platform:text_7d1cf521bdc8') };
                actionRunning.current = true;
                setBusy(true);
                setActionError('');
                try {
                  await scope.request(
                    `/skills/${encodeURIComponent(skill.id)}/${transition}`,
                    'POST',
                    {
                      expectedActiveId,
                    },
                  );
                  await refresh();
                  setNotice(
                    transition === 'disable'
                      ? uiText('platform:text_8ad6e79cdc89')
                      : uiText('platform:text_117d52139680'),
                  );
                  return { ok: true };
                } catch (cause) {
                  return { ok: false, error: (cause as Error).message };
                } finally {
                  actionRunning.current = false;
                  if (mounted.current) setBusy(false);
                }
              }}
            />
          ) : (
            <AdminEmpty>{uiText('platform:text_ad6d391cfa42')}</AdminEmpty>
          )}
        </Dialog>
      )}
    </main>
  );
}

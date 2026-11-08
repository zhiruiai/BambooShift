import { uiText } from '../../i18n';
import { ArrowLeft, Info, Loader2, ShieldCheck } from 'lucide-react';
import '../AppsDialog.css';
import './AppsDialogLayout.css';
import { Dialog } from '../UI';
import { AddAppConnectionView } from './AddAppConnectionView';
import { AppConnectionDetailsView } from './AppConnectionDetailsView';
import { AppConnectionsListView } from './AppConnectionsListView';
import { AppApprovalRulesPanel } from './AppApprovalRulesPanel';
import { PrivateSkillsPanel } from './PrivateSkillsPanel';
import { PackagedSkillsCatalog } from './PackagedSkillsCatalog';
import type { useAppsDialogContent } from './useAppsDialogContent';
export type AppsDialogContentModel = ReturnType<typeof useAppsDialogContent>;
export function AppsDialogContentView(model: AppsDialogContentModel) {
  const {
    view,
    selectedApp,
    props,
    close,
    busy,
    navigate,
    error,
    notice,
    uncertain,
    loading,
    refresh,
  } = model;
  const feedback = (
    <>
      <p className="apps-sharing">
        <ShieldCheck size={16} />
        <span>
          {uiText('apps:text_5d66e5c7df87')}
          {props.team ? uiText('apps:text_9c355cebc5ef') : ''}
          {uiText('apps:text_de9a8e7d0608')}
        </span>
      </p>
      {!props.canManage && <p className="field-help">{uiText('apps:text_172dacbe79fe')}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="apps-notice" role="status">
          {notice}
        </p>
      )}
      {uncertain && (
        <div className="info-box">
          <Info size={16} />
          <span>{uiText('apps:text_d2152ebad452')}</span>
          <button
            type="button"
            className="text-button"
            disabled={busy || loading}
            onClick={() => void refresh()}
          >
            {uiText('apps:text_802a407c7743')}
          </button>
        </div>
      )}
    </>
  );
  return (
    <Dialog
      scrollBody={false}
      title={
        view === 'add'
          ? uiText('apps:text_41dd056c292a')
          : view === 'detail'
            ? selectedApp?.name || uiText('apps:text_a6a0fdcd4030')
            : view === 'rules'
              ? uiText('apps:approvalRulesTitle')
              : view === 'skills'
                ? uiText('apps:privateSkillsTitle')
                : view === 'packaged-skills'
                  ? uiText('workspace:packagedSkillsTitle')
                  : uiText('apps:text_b1bea2878095')
      }
      subtitle={`${props.workspaceName} · ${props.team ? uiText('apps:text_92ee0cd82f1c') : uiText('apps:text_7c96c5f47c00')}`}
      onClose={close}
      className={`apps-dialog apps-${view}-dialog`}
    >
      {view !== 'list' && (
        <div className="apps-navigation">
          <button
            className="text-button apps-back"
            type="button"
            disabled={busy}
            onClick={() => navigate('list')}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {uiText('apps:text_74523742d407')}
          </button>
        </div>
      )}
      {view === 'list' ? (
        <AppConnectionsListView {...model} feedback={feedback} />
      ) : view === 'packaged-skills' && props.packagedSkills ? (
        <PackagedSkillsCatalog
          bots={props.packagedSkills.bots}
          canEdit={props.canManage && !!props.userId && !!props.workspaceId}
          disabled={busy}
          onEdit={(draft) => {
            if (props.canManage && !busy && model.scope.current(model.scope.ticket()))
              props.packagedSkills?.onEdit(draft);
          }}
        />
      ) : view === 'review' ? (
        <div className="apps-scroll">
          {feedback}
          {loading ? (
            <p className="field-help" role="status">
              <Loader2 size={15} className="spin" aria-hidden="true" />{' '}
              {uiText('workspace:appProposalChecking')}
            </p>
          ) : (
            <button type="button" className="secondary-button" onClick={() => void refresh()}>
              {uiText('workspace:appProposalRetry')}
            </button>
          )}
        </div>
      ) : view === 'add' ? (
        <AddAppConnectionView {...model} feedback={feedback} />
      ) : view === 'rules' || view === 'skills' ? (
        <div className="apps-scroll">
          {model.personalOwner &&
            (view === 'rules' ? (
              <AppApprovalRulesPanel
                scope={model.scope}
                onBusyChange={model.setPolicyBusy}
                onChanged={props.onChanged}
              />
            ) : (
              <PrivateSkillsPanel
                scope={model.scope}
                workspaceId={props.workspaceId}
                userId={props.userId}
                onBusyChange={model.setPolicyBusy}
                onChanged={props.onChanged}
              />
            ))}
        </div>
      ) : (
        <div className="apps-scroll">
          {feedback}
          <AppConnectionDetailsView {...model} />
        </div>
      )}
    </Dialog>
  );
}

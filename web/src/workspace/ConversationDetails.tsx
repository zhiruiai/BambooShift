import { uiText } from '../i18n';
import {
  BookOpen,
  ChevronRight,
  FolderOpen,
  Monitor,
  Plus,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { isSharedBot } from '../../../shared/shared-bots';
import { conversationVisibility } from '../approvalUi';
import { Avatar, GroupAvatar } from '../components/Avatar';
import { BotTeamBrief } from '../components/BotTeamBrief';
import { FileCard } from '../components/FileCard';
import { SharedBotFiles } from '../components/SharedBotFiles';
import { WebsiteProjectLibrary } from '../components/WebsiteProjectCard';
import type { OpenWebsiteProject } from '../websiteProjects';
import { IconButton } from '../components/UI';
import { workspaceApiUrl } from '../workspace-scope';
import type { WorkspaceModel } from './types';
import { DetailTabs } from './details/DetailTabs';
import { ConversationComputer } from './details/ConversationComputer';
import { ConversationLinks } from './details/ConversationLinks';
import { ConversationRoutines } from './details/ConversationRoutines';

export function ConversationDetails({
  api,
  showDetail,
  conversation,
  toggleDetails,
  members,
  lead,
  account,
  detailTab,
  setDetailTab,
  data,
  setModal,
  sidebarComputer,
  selectedComputerAgent,
  selectedComputerAgentId,
  setConversationScreens,
  navigationScope,
  selected,
  currentUserId,
  modal,
  openComputer,
  canManage,
  setRoutineToEdit,
  setRoutineInitialAction,
  busy,
  sendScope,
  routines,
  action,
  memories,
  skills,
  setInspected,
  files,
  uploading,
  fileRef,
  setTransferFile,
  messages,
  jumpToMessage,
  openWebsiteProject,
}: Pick<
  WorkspaceModel,
  | 'api'
  | 'showDetail'
  | 'conversation'
  | 'toggleDetails'
  | 'members'
  | 'lead'
  | 'account'
  | 'detailTab'
  | 'setDetailTab'
  | 'data'
  | 'setModal'
  | 'sidebarComputer'
  | 'selectedComputerAgent'
  | 'selectedComputerAgentId'
  | 'setConversationScreens'
  | 'navigationScope'
  | 'selected'
  | 'currentUserId'
  | 'modal'
  | 'openComputer'
  | 'canManage'
  | 'setRoutineToEdit'
  | 'setRoutineInitialAction'
  | 'busy'
  | 'sendScope'
  | 'routines'
  | 'action'
  | 'memories'
  | 'skills'
  | 'setInspected'
  | 'files'
  | 'uploading'
  | 'fileRef'
  | 'setTransferFile'
  | 'messages'
  | 'jumpToMessage'
> & { openWebsiteProject?: OpenWebsiteProject }) {
  return (
    <>
      {showDetail && conversation && (
        <aside className="details-panel" aria-label={uiText('workspace:text_1448e376cbc5')}>
          <div className="details-toolbar">
            <span>{uiText('workspace:text_6fed7e860168')}</span>
            <IconButton
              label={uiText('workspace:text_9071cfe7cd01')}
              onClick={() => toggleDetails(false)}
            >
              <X size={16} />
            </IconButton>
          </div>
          <div className="detail-identity">
            {conversation?.isGroup ? (
              <GroupAvatar agents={members} size={71} />
            ) : (
              <Avatar agent={lead} size={64} />
            )}
            <h2>{conversation?.title}</h2>
            <p>{conversation?.isGroup ? uiText('workspace:text_e6c435204ba8') : lead?.role}</p>
            <p className="field-help">
              {conversationVisibility(account?.workspace.kind)}
              {account?.workspace.kind === 'team' && uiText('workspace:text_09c95b68e4ff')}
            </p>
          </div>
          <DetailTabs value={detailTab} group={!!conversation.isGroup} onChange={setDetailTab} />
          <div
            className="detail-content"
            role="tabpanel"
            id={`detail-content-${detailTab}`}
            aria-labelledby={`detail-tab-${detailTab}`}
          >
            {detailTab === 'details' ? (
              <>
                {conversation?.teamBrief && (
                  <BotTeamBrief
                    conversation={conversation}
                    agents={data.agents}
                    onManage={() => setModal('group')}
                  />
                )}
                <ConversationRoutines
                  canManage={canManage}
                  routines={routines}
                  setRoutineToEdit={setRoutineToEdit}
                  setRoutineInitialAction={setRoutineInitialAction}
                  setModal={setModal}
                  busy={busy}
                  modal={modal}
                  api={api}
                  action={action}
                  sendScope={sendScope}
                  navigationScope={navigationScope}
                />
                <section className="detail-section resources">
                  <div className="section-label">{uiText('workspace:text_b89e7388bace')}</div>
                  <button onClick={() => setModal('memory')}>
                    <span className="resource-icon lavender">
                      <BookOpen size={16} />
                    </span>
                    <span>
                      {uiText('workspace:text_b80e99482ac0')}
                      <small>{uiText('workspace:text_5f3fcaac3777')}</small>
                    </span>
                    <span className="count">{memories.length}</span>
                    <ChevronRight size={14} />
                  </button>
                  <button onClick={() => setModal('skills')}>
                    <span className="resource-icon amber">
                      <Sparkles size={16} />
                    </span>
                    <span>
                      {uiText('workspace:text_2c38f222bfa4')}
                      <small>
                        {skills.some((s) => s.status === 'proposed')
                          ? canManage
                            ? uiText('workspace:text_8283222a5ba5')
                            : uiText('workspace:text_e231393e652b')
                          : uiText('workspace:text_c4d487e694b0')}
                      </small>
                    </span>
                    <span className="count">{skills.length}</span>
                    <ChevronRight size={14} />
                  </button>
                </section>
                {conversation?.isGroup && (
                  <section className="detail-section">
                    <div className="section-label">
                      <span>{uiText('workspace:text_118a0007f070')}</span>
                      <button className="text-button" onClick={() => setDetailTab('members')}>
                        {uiText('workspace:text_fa2ff3c379a7')}
                      </button>
                    </div>
                    {members.slice(0, 3).map((a) => (
                      <button
                        key={a.id}
                        className="member-mini"
                        onClick={() => {
                          setInspected(a.id);
                          setModal('agent');
                        }}
                      >
                        <Avatar agent={a} size={26} />
                        <span>{a.name}</span>
                        <span className="member-status">
                          {a.status === 'working'
                            ? uiText('workspace:text_f42082263714')
                            : uiText('workspace:text_b073db9c0bd6')}
                        </span>
                      </button>
                    ))}
                  </section>
                )}
              </>
            ) : detailTab === 'computer' ? (
              <ConversationComputer
                conversation={conversation}
                members={members}
                sidebarComputer={sidebarComputer}
                selectedComputerAgent={selectedComputerAgent}
                selectedComputerAgentId={selectedComputerAgentId}
                setConversationScreens={setConversationScreens}
                navigationScope={navigationScope}
                selected={selected}
                account={account}
                currentUserId={currentUserId}
                modal={modal}
                openComputer={openComputer}
              />
            ) : detailTab === 'files' ? (
              <>
                {openWebsiteProject && (
                  <WebsiteProjectLibrary messages={messages} onOpen={openWebsiteProject} />
                )}
                <ConversationLinks
                  key={`${navigationScope}:${conversation.id}`}
                  conversationId={conversation.id}
                  messages={data.messages}
                  onJump={(id) => {
                    if (sendScope.current(sendScope.ticket())) jumpToMessage(conversation.id, id);
                  }}
                />
                {currentUserId &&
                  members
                    .filter((agent) => isSharedBot(agent) && agent.sharedBot?.shareId)
                    .map((agent) => (
                      <SharedBotFiles
                        key={`${navigationScope}:${agent.id}`}
                        agent={agent}
                        userId={currentUserId}
                      />
                    ))}
                <div className="section-label">
                  <span>
                    {account?.workspace.kind === 'personal'
                      ? uiText('workspace:text_e8ba8d100ae5')
                      : uiText('workspace:text_6d4624ac777e')}{' '}
                    · {files.length}
                  </span>
                  <IconButton
                    label={uiText('workspace:text_19e48687c67d')}
                    disabled={uploading.has(selected)}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Plus size={15} />
                  </IconButton>
                </div>
                <p className="section-help">{uiText('workspace:text_180b5dd570bd')}</p>
                <button
                  className="library-computer-link"
                  onClick={() => openComputer(undefined, 'files')}
                >
                  <FolderOpen size={14} />
                  {uiText('workspace:text_920b2b450375')}
                  <ChevronRight size={13} />
                </button>
                {files.length ? (
                  files.map((f) => (
                    <div className="library-file" key={f.id}>
                      <FileCard
                        name={f.name}
                        size={f.size}
                        href={workspaceApiUrl(`/api/files/${f.id}/download`)}
                      />
                      {f.source?.kind === 'computer' && (
                        <p className="library-file-source">
                          {uiText('workspace:text_df6e36f75c22')}
                          {f.source.computerName} · {f.source.path}
                        </p>
                      )}
                      <button
                        type="button"
                        className="library-file-send"
                        onClick={() => {
                          setTransferFile({
                            file: f,
                            conversationId: selected,
                            conversationTitle:
                              conversation?.title || uiText('workspace:text_9800a458c16b'),
                          });
                          setModal('file-transfer');
                        }}
                      >
                        <Monitor size={12} />
                        {uiText('workspace:text_8272cf0a0f36')}
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="detail-empty">
                    <FolderOpen size={30} />
                    <p>{uiText('workspace:text_b9a42d9cc233')}</p>
                    <button className="secondary-button" onClick={() => fileRef.current?.click()}>
                      {uiText('workspace:text_ad9daebe00dc')}
                    </button>
                  </div>
                )}
              </>
            ) : conversation?.isGroup ? (
              <>
                <BotTeamBrief
                  conversation={conversation}
                  agents={data.agents}
                  onManage={() => setModal('group')}
                />
                <div className="section-label">
                  {members.length}
                  {uiText('workspace:text_e0c44489ceaf')}
                </div>
                {members.map((a) => (
                  <button
                    key={a.id}
                    className="member-row"
                    onClick={() => {
                      setInspected(a.id);
                      setModal('agent');
                    }}
                  >
                    <Avatar agent={a} size={34} />
                    <span>
                      {a.name}
                      <small>{a.role}</small>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                ))}
                <button className="add-detail-row" onClick={() => setModal('group')}>
                  <Plus size={17} />
                  {uiText('workspace:text_5098a74928d1')}
                </button>
              </>
            ) : (
              <>
                <div className="section-label">
                  <span>{uiText('workspace:text_69d86f88c24c')}</span>
                  <IconButton
                    label={uiText('workspace:text_52f321bfb32b')}
                    onClick={() => setModal('memory')}
                  >
                    <Plus size={15} />
                  </IconButton>
                </div>
                {memories.map((m) => (
                  <div className="memory-note" key={m.id}>
                    <BookOpen size={14} />
                    <p>{m.content}</p>
                  </div>
                ))}
                <button className="add-detail-row" onClick={() => setModal('memory')}>
                  <Plus size={15} />
                  {uiText('workspace:text_aca35ae1a885')}
                </button>
              </>
            )}
          </div>
          <div className="details-footer">
            <ShieldCheck size={12} />
            {uiText('workspace:text_c4a503753984')}
          </div>
        </aside>
      )}
    </>
  );
}

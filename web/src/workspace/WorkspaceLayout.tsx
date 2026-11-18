import { uiText } from '../i18n';
import { ArrowLeft, Info, X } from 'lucide-react';
import { ChatComposer } from './ChatComposer';
import { ChatHeader } from './ChatHeader';
import { ChatMessages } from './ChatMessages';
import { ConversationDetails } from './ConversationDetails';
import type { WorkspaceModel } from './types';
import { WorkspacePeopleDialogs } from './WorkspacePeopleDialogs';
import { WorkspaceResourceDialogs } from './WorkspaceResourceDialogs';
import { WorkspaceSharingDialogs } from './WorkspaceSharingDialogs';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { WorkspaceTaskDialogs } from './WorkspaceTaskDialogs';
import { useWorkspaceWebsite } from './WorkspaceWebsite';
import { useRecruiterShortcut } from './useRecruiterShortcut';
import { useVoiceCall } from '../useVoiceCall';
import { ActiveVoiceCall } from '../components/VoiceCallControls';
export function WorkspaceLayout(model: WorkspaceModel) {
  const website = useWorkspaceWebsite(model);
  const call = useVoiceCall(model);
  const recruiter = useRecruiterShortcut({
    model,
    blocked: call.active || (model.mobileHome && !model.mobileChat),
  });
  const recruiterFromCreate = useRecruiterShortcut({
    model,
    entry: 'create',
    blocked: call.active,
  });
  const {
    mobileChat,
    showDetail,
    selected,
    setToast,
    draggingFiles,
    enterFiles,
    leaveFiles,
    dropFiles,
    hasFiles,
    modal,
    uploadingRef,
    toast,
    threadRoot,
    closeThread,
  } = model;
  return (
    <main
      className={`app-shell ${mobileChat ? 'mobile-chat-open' : ''} ${website.panel ? 'with-website' : showDetail ? 'with-detail' : ''}`}
    >
      <WorkspaceSidebar {...model} />
      <section
        className={`chat-panel ${draggingFiles ? 'file-drag-active' : ''}`}
        aria-label={uiText('workspace:text_4b3510b8d86e')}
        onDragEnter={enterFiles}
        onDragLeave={leaveFiles}
        onDrop={dropFiles}
        onKeyDown={(event) => {
          if (
            !threadRoot ||
            modal ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.key !== 'Escape'
          )
            return;
          event.preventDefault();
          closeThread();
        }}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect =
            modal || !selected || uploadingRef.current.has(selected) ? 'none' : 'copy';
        }}
      >
        <ChatHeader
          {...model}
          showDetail={!website.panel && showDetail}
          toggleDetails={
            website.panel
              ? () => {
                  website.dismiss();
                  model.toggleDetails(true);
                }
              : model.toggleDetails
          }
        />
        {threadRoot && (
          <div className="reply-thread-bar">
            <button type="button" onClick={closeThread}>
              <ArrowLeft size={16} aria-hidden="true" />
              {uiText('workspace:threadBack')}
            </button>
            <h2>{uiText('workspace:threadTitle')}</h2>
          </div>
        )}
        <ChatMessages
          {...model}
          voice={
            call.active || (model.mobileHome && !mobileChat)
              ? { ...model.voice, blocked: true }
              : model.voice
          }
          openWebsiteProject={website.open}
        />
        <ChatComposer
          {...model}
          recruiter={recruiter}
          websiteEdit={website.editContext}
          voiceCall={call}
          voiceCallPanel={
            <ActiveVoiceCall
              key={selected}
              call={call}
              agentName={model.lead?.name}
              voice={model.voice}
            />
          }
        />
      </section>
      {website.panel || <ConversationDetails {...model} openWebsiteProject={website.open} />}
      {toast && (
        <div className="toast" role="status">
          <Info size={16} />
          {toast}
          <button aria-label={uiText('workspace:text_d301bc125833')} onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      <WorkspacePeopleDialogs {...model} recruiterShortcut={recruiterFromCreate} />
      <WorkspaceResourceDialogs {...model} openWebsiteSearchResult={website.openSearchResult} />
      <WorkspaceSharingDialogs {...model} />
      <WorkspaceTaskDialogs {...model} />
    </main>
  );
}

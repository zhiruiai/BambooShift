import { useMemo } from 'react';
import { ChevronRight, FolderOpen, Monitor, Plus } from 'lucide-react';
import type { Conversation } from '../../../../shared/types';
import { isSharedBot } from '../../../../shared/shared-bots';
import { conversationLibraryItems, type LibraryItem } from '../../conversationLibrary';
import { FileCard } from '../../components/FileCard';
import { SharedBotFiles } from '../../components/SharedBotFiles';
import { WebsiteProjectCard } from '../../components/WebsiteProjectCard';
import { uiText } from '../../i18n';
import type { OpenWebsiteProject } from '../../websiteProjects';
import { workspaceApiUrl } from '../../workspace-scope';
import type { WorkspaceModel } from '../types';
import { ConversationLibrary } from './ConversationLibrary';
import { ConversationLinkRow } from './ConversationLinkRow';
import { useLibraryPins } from './useLibraryPins';

type Props = Pick<
  WorkspaceModel,
  | 'api'
  | 'currentUserId'
  | 'data'
  | 'fileRef'
  | 'files'
  | 'jumpToMessage'
  | 'members'
  | 'openComputer'
  | 'sendScope'
  | 'setModal'
  | 'setTransferFile'
  | 'uploading'
> & { conversation: Conversation; openWebsiteProject?: OpenWebsiteProject };

export function ConversationLibraryView({
  api,
  currentUserId,
  data,
  fileRef,
  files,
  jumpToMessage,
  members,
  openComputer,
  sendScope,
  setModal,
  setTransferFile,
  uploading,
  conversation,
  openWebsiteProject,
}: Props) {
  const { id, title } = conversation;
  const items = useMemo(
    () => conversationLibraryItems(id, data.messages, files),
    [id, data.messages, files],
  );
  const revision = data.sync && `${data.sync.epoch}:${data.sync.revision}`;
  const pins = useLibraryPins(api, id, revision, !!currentUserId);

  function renderItem(item: LibraryItem) {
    if (item.kind === 'website')
      return <WebsiteProjectCard message={item.message} onOpen={openWebsiteProject} />;
    if (item.kind === 'link')
      return (
        <ConversationLinkRow
          href={item.href}
          label={item.title}
          onJump={() => {
            if (sendScope.current(sendScope.ticket())) jumpToMessage(id, item.messageId);
          }}
        />
      );
    const file = item.sourceFile;
    return (
      <div className="library-file">
        <FileCard
          name={file.name}
          size={file.size}
          href={workspaceApiUrl(`/api/files/${file.id}/download`)}
        />
        {file.source?.kind === 'computer' && (
          <p className="library-file-source">
            {uiText('workspace:text_df6e36f75c22')}
            {file.source.computerName} · {file.source.path}
          </p>
        )}
        <button
          type="button"
          className="library-file-send"
          onClick={() => {
            setTransferFile({ file, conversationId: id, conversationTitle: title });
            setModal('file-transfer');
          }}
        >
          <Monitor size={12} aria-hidden="true" />
          {uiText('workspace:text_8272cf0a0f36')}
        </button>
      </div>
    );
  }

  return (
    <ConversationLibrary
      {...pins}
      items={items}
      renderItem={renderItem}
      fileTools={
        <div className="conversation-library-file-tools">
          <button
            type="button"
            className="library-computer-link"
            disabled={uploading.has(id)}
            onClick={() => fileRef.current?.click()}
          >
            <Plus size={14} aria-hidden="true" />
            {uiText('workspace:text_19e48687c67d')}
            <ChevronRight size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="library-computer-link"
            onClick={() => openComputer(undefined, 'files')}
          >
            <FolderOpen size={14} aria-hidden="true" />
            {uiText('workspace:text_920b2b450375')}
            <ChevronRight size={13} aria-hidden="true" />
          </button>
          {currentUserId &&
            members
              .filter((agent) => isSharedBot(agent) && agent.sharedBot?.shareId)
              .map((agent) => (
                <SharedBotFiles key={agent.id} agent={agent} userId={currentUserId} />
              ))}
        </div>
      }
    />
  );
}

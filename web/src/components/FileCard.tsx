import { useEffect, useRef, useState } from 'react';
import { uiText } from '../i18n';
import { Download, FileText } from 'lucide-react';
import { fileSize } from '../fileFormatting';
import { useAccount } from '../AccountContext';
import { currentWorkspaceId } from '../workspace-scope';
import { previewFilePath, type FilePreviewIdentity } from '../filePreview';
import { FilePreviewDialog } from './FilePreviewDialog';

type FileCardProps = { name: string; size: number; href?: string };

export function FileCard(props: FileCardProps) {
  const account = useAccount();
  return (
    <FileCardContent
      {...props}
      identity={{
        userId: account?.session.user?.id,
        workspaceId: account?.workspace.id || currentWorkspaceId(),
        pathname: window.location.pathname,
      }}
    />
  );
}

export function FileCardContent({
  name,
  size,
  href,
  identity,
}: FileCardProps & { identity: FilePreviewIdentity }) {
  const latest = useRef({ name, href, identity, epoch: 0 });
  const previous = latest.current;
  const changed =
    previous.name !== name ||
    previous.href !== href ||
    previous.identity.userId !== identity.userId ||
    previous.identity.workspaceId !== identity.workspaceId ||
    previous.identity.pathname !== identity.pathname;
  const epoch = previous.epoch + (changed ? 1 : 0);
  latest.current = { name, href, identity, epoch };
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [opened, setOpened] = useState<{
    name: string;
    href: string;
    epoch: number;
    identity: FilePreviewIdentity;
    currentIdentity: () => FilePreviewIdentity;
  }>();
  useEffect(() => {
    setOpened((value) => (value?.epoch === epoch ? value : undefined));
  }, [epoch]);
  const valid = (value: {
    name: string;
    href?: string;
    identity: FilePreviewIdentity;
    epoch: number;
  }) => {
    const current = latest.current;
    return (
      live.current &&
      current.epoch === value.epoch &&
      current.name === value.name &&
      current.href === value.href &&
      current.identity.userId === value.identity.userId &&
      current.identity.workspaceId === value.identity.workspaceId &&
      window.location.pathname === value.identity.pathname &&
      current.identity.pathname === value.identity.pathname
    );
  };
  const body = (
    <>
      <span className="file-icon">
        <FileText size={20} />
      </span>
      <span className="file-copy">
        <strong>{name}</strong>
        <small>{size ? fileSize(size) : uiText('common:text_2101f3309884')}</small>
      </span>
    </>
  );
  const path = href && previewFilePath(href, identity);
  if (!path) return <div className="file-card">{body}</div>;
  return (
    <>
      <div className="file-card file-card-preview">
        <button
          type="button"
          className="file-card-open"
          aria-label={`${uiText('workspace:filePreviewOpen')} ${name}`}
          onClick={() => {
            if (valid({ name, href, identity, epoch }))
              setOpened({
                name,
                href: path,
                epoch,
                identity,
                currentIdentity: () => ({
                  ...latest.current.identity,
                  pathname: window.location.pathname,
                }),
              });
          }}
        >
          {body}
        </button>
        <a
          className="file-card-download"
          href={path}
          download
          aria-label={`${uiText('workspace:filePreviewDownload')} ${name}`}
          onClick={(event) => {
            if (!valid({ name, href, identity, epoch })) event.preventDefault();
          }}
        >
          <Download size={16} />
        </a>
      </div>
      {opened && valid(opened) && (
        <FilePreviewDialog {...opened} onClose={() => setOpened(undefined)} />
      )}
    </>
  );
}

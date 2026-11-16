import type { Message, WorkspaceFile } from '../../shared/types';
import { messageLinks } from './messageLinks';
import { websiteProjectFor } from './websiteProjects';

type LibraryItemBase = {
  target: string;
  createdAt: string;
  title: string;
  media: boolean;
};
export type LibraryItem = LibraryItemBase &
  (
    | { kind: 'website'; message: Message }
    | { kind: 'file'; sourceFile: WorkspaceFile }
    | { kind: 'link'; messageId: string; href: string }
  );
export type LibraryPin = Pick<LibraryItem, 'kind' | 'target'> & { pinnedAt: string };

export function libraryItemKey({ kind, target }: Pick<LibraryItem, 'kind' | 'target'>) {
  return `${kind}:${target}`;
}

function isMedia(file: WorkspaceFile) {
  const mime = (file.type || '').toLowerCase().split(';', 1)[0];
  if (/^(image|audio|video)\//.test(mime)) return true;
  return (
    (!mime || mime === 'application/octet-stream') &&
    /\.(avif|gif|heic|jpe?g|png|svg|webp|aac|flac|m4a|mp3|ogg|wav|mov|mp4|webm)$/i.test(file.name)
  );
}

export function conversationLibraryItems(
  conversationId: string,
  messages: readonly Message[],
  files: readonly WorkspaceFile[],
): LibraryItem[] {
  const items: LibraryItem[] = files
    .filter((file) => !file.conversationId || file.conversationId === conversationId)
    .map((file) => ({
      kind: 'file',
      target: file.id,
      createdAt: file.createdAt,
      title: file.name,
      media: isMedia(file),
      sourceFile: file,
    }));
  const websites = new Set<string>();
  const links = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.conversationId !== conversationId) continue;
    const website = websiteProjectFor(message);
    if (website && !websites.has(website.projectKey)) {
      websites.add(website.projectKey);
      items.push({
        kind: 'website',
        target: website.projectKey,
        createdAt: message.createdAt,
        title: website.title,
        media: false,
        message,
      });
    }
    for (const { href, label } of messageLinks(message)) {
      if (links.has(href)) continue;
      links.add(href);
      items.push({
        kind: 'link',
        target: href,
        createdAt: message.createdAt,
        title: label,
        media: false,
        messageId: message.id,
        href,
      });
    }
  }
  return items.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

export function readLibraryPins(value: unknown): LibraryPin[] {
  const pins = (value as { pins?: unknown } | null)?.pins;
  if (!Array.isArray(pins)) throw new Error('Invalid library pins');
  return pins.map((pin: LibraryPin) => {
    if (
      !pin ||
      !['website', 'file', 'link'].includes(pin.kind) ||
      typeof pin.target !== 'string' ||
      !pin.target ||
      !Number.isFinite(Date.parse(pin.pinnedAt))
    )
      throw new Error('Invalid library pin');
    return { kind: pin.kind, target: pin.target, pinnedAt: pin.pinnedAt };
  });
}

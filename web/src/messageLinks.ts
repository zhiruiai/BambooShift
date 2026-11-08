import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Message } from '../../shared/types';

type MessageLink = { label: string; href: string };
type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  alt?: string | null;
};
const parser = unified().use(remarkParse).use(remarkGfm).freeze();
const indexed = new WeakMap<Message, MessageLink[]>();
const MAX_MESSAGE_LINKS = 64;

function labelFor(node: MarkdownNode): string {
  return node.children?.map(labelFor).join('') ?? node.value ?? node.alt ?? '';
}

function webLink(value: string | undefined) {
  if (!value || !/^https?:\/\//i.test(value) || /[\s\\\p{Cc}]/u.test(value)) return;
  if (!URL.canParse(value)) return;
  const url = new URL(value);
  if (url.hostname && !url.username && !url.password) return url.href;
}

export function messageLinks(message: Message): MessageLink[] {
  if (
    (message.role !== 'user' && message.role !== 'assistant') ||
    (message.kind && message.kind !== 'text') ||
    message.status === 'running' ||
    !/https?:\/\/|www\./i.test(message.content)
  )
    return [];
  const cached = indexed.get(message);
  if (cached) return cached;

  // Match the transcript's Markdown and GFM autolink semantics without rendering it.
  const definitions = new Map<string, string>();
  const candidates: Array<{ node: MarkdownNode; url?: string; reference?: string }> = [];
  const pending = [...parser.parse(message.content).children].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    } else if (node.type === 'link') {
      candidates.push({ node, url: node.url });
    } else if (node.type === 'linkReference') {
      candidates.push({ node, reference: node.identifier });
    }
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
    }
  }

  const links = new Map<string, MessageLink>();
  for (const { node, url, reference } of candidates) {
    const href = webLink(reference === undefined ? url : definitions.get(reference));
    if (href && !links.has(href)) {
      links.set(href, { href, label: labelFor(node).trim() || href });
      if (links.size === MAX_MESSAGE_LINKS) break;
    }
  }
  const result = [...links.values()];
  indexed.set(message, result);
  return result;
}

import { memo } from 'react';
import { currentLanguage, uiText } from '../i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { currentWorkspaceId, workspaceApiUrl } from '../workspace-scope';

type MarkdownProps = { text: string; passive?: boolean };

/** Shared renderer for messages and skill review. Raw HTML stays disabled. */
export function Markdown({ text, passive = false }: MarkdownProps) {
  // Preserve rendered history while the composer or latest reply changes. Scope and
  // language changes must still re-render relative links and accessible labels.
  return (
    <MarkdownContent
      text={text}
      passive={passive}
      locale={currentLanguage()}
      workspace={currentWorkspaceId()}
    />
  );
}
const MarkdownContent = memo(function MarkdownContent({
  text,
  passive,
}: MarkdownProps & {
  locale: ReturnType<typeof currentLanguage>;
  workspace?: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml={passive}
      urlTransform={passive ? () => undefined : undefined}
      components={{
        a: ({ children, href }) =>
          passive ? (
            <span>{children}</span>
          ) : (
            <a
              href={href ? workspaceApiUrl(href) : undefined}
              target={href?.startsWith('/api/') ? undefined : '_blank'}
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        img: ({ src, alt, ...props }) =>
          passive ? (
            <span className="markdown-file-image-label">
              {alt || uiText('workspace:filePreviewMarkdownImage')}
            </span>
          ) : (
            <img {...props} src={src ? workspaceApiUrl(src) : undefined} alt={alt || ''} />
          ),
        table: ({ children }) => (
          <div
            className="markdown-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={uiText('common:text_11392a0424f9')}
          >
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

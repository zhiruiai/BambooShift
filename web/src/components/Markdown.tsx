import { uiText } from '../i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { workspaceApiUrl } from '../workspace-scope';

/** Shared renderer for messages and skill review. Raw HTML stays disabled. */
export function Markdown({ text, passive = false }: { text: string; passive?: boolean }) {
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
}

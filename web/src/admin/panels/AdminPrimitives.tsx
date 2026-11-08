import { currentLanguage } from '../../i18n';
import { uiText } from '../../i18n';
import { Activity, ArrowUpRight } from 'lucide-react';
import { type ReactNode } from 'react';
import { conversationHref } from './types';
export function adminTime(value?: string) {
  if (!value) return uiText('platform:text_46ca86da52b3');
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? uiText('platform:text_664939a1fa2e')
    : date.toLocaleString(currentLanguage(), { hour12: false });
}
export function bytes(size: number) {
  if (size >= 1048576) return `${(size / 1048576).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}
export function AdminStatus({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`admin-status ${tone ? `is-${tone}` : ''}`}>{children}</span>;
}
export function AdminEmpty({
  children,
  detail,
  icon = <Activity size={23} />,
}: {
  children: ReactNode;
  detail?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="admin-empty">
      {icon}
      <p>{children}</p>
      {detail && <small>{detail}</small>}
    </div>
  );
}
export function Card({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="admin-card">
      <div className="admin-card-heading">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function ConversationLink({
  id,
  messageId,
  children = uiText('platform:text_2da0b2a8111d'),
}: {
  id: string;
  messageId?: string;
  children?: ReactNode;
}) {
  return (
    <a className="admin-plain-link" href={conversationHref(id, messageId)}>
      {children}
      <ArrowUpRight size={13} />
    </a>
  );
}

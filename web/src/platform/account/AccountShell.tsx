import { uiText } from '../../i18n';
import { type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import '../Platform.css';
export function AccountShell({
  title,
  subtitle,
  children,
  operator = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  operator?: boolean;
}) {
  return (
    <main className={`platform-auth ${operator ? 'is-operator' : ''}`}>
      <a className="platform-brand" href={operator ? '/admin/login' : '/login'}>
        <Avatar size={33} />
        <span>MosoCrew{operator && <small>{uiText('account:text_e0f17eefe421')}</small>}</span>
      </a>
      <section className="platform-auth-card">
        <Avatar size={57} />
        <h1>{title}</h1>
        {subtitle && <p className="platform-auth-subtitle">{subtitle}</p>}
        {children}
      </section>
      <footer>
        {operator ? uiText('account:text_e49a9a1fcfdf') : uiText('account:text_731b94938d9f')}
      </footer>
    </main>
  );
}

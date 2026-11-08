import { useEffect } from 'react';
import { uiText } from '../../web/src/i18n';
import { useLanguage } from '../../web/src/i18n/useLanguage';
import { supportedLanguage } from '../../web/src/i18n/language';
import { OperatorLoginPage } from './OperatorLoginPage';
import { PlatformAdminApp } from './PlatformAdminApp';
import './Operations.css';

export default function OperationsRoot() {
  const language = useLanguage();
  const path = window.location.pathname;
  useEffect(() => {
    document.title = uiText('platform:operationsTitle');
  }, [language.locale]);
  return (
    <>
      <div className="operations-language-toolbar">
        <label>
          <span>{uiText('settings:language')}</span>
          <select
            value={language.locale}
            onChange={(event) => {
              if (supportedLanguage(event.target.value)) language.setLanguage(event.target.value);
            }}
          >
            <option value="zh-CN">{uiText('settings:text_9937e365aaf3')}</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      {path === '/admin/setup' ? (
        <OperatorLoginPage setup />
      ) : path === '/admin/login' ? (
        <OperatorLoginPage />
      ) : (
        <PlatformAdminApp />
      )}
    </>
  );
}

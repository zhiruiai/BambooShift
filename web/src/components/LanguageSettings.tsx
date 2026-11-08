import { useEffect, useRef } from 'react';
import { uiText } from '../i18n';
import { useLanguage } from '../i18n/useLanguage';
import { supportedLanguage } from '../i18n/language';

export function LanguageSettings({
  active = true,
  compact = false,
}: {
  active?: boolean;
  compact?: boolean;
}) {
  const language = useLanguage();
  const current = useRef({ active, mounted: true });
  current.current.active = active;
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, []);
  return (
    <div className="appearance-language-row">
      <label className="appearance-setting-row">
        <span>{uiText('settings:language')}</span>
        <select
          value={language.locale}
          disabled={!active}
          onChange={(event) => {
            if (
              current.current.active &&
              current.current.mounted &&
              supportedLanguage(event.target.value)
            )
              language.setLanguage(event.target.value);
          }}
        >
          <option value="zh-CN">{uiText('settings:text_9937e365aaf3')}</option>
          <option value="en">English</option>
        </select>
      </label>
      {!compact && <p className="field-help">{uiText('settings:languageHelp')}</p>}
      {!language.storageAvailable && (
        <p role="status" className="field-help">
          {uiText('settings:storageUnavailable')}
        </p>
      )}
    </div>
  );
}

import { uiText } from './i18n';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { LocalizedRoot } from './i18n/LocalizedRoot';
import { initializeLanguage } from './i18n';
import { initializeAppearance } from './appearance';
import './styles.css';
import './theme.css';

initializeAppearance();
initializeLanguage();

if (/(?:^|\s)OpenBotDesktop\/[\d.]+(?:\s|$)/.test(navigator.userAgent)) {
  document.documentElement.dataset.openbotDesktop = 'true';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocalizedRoot />
  </React.StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

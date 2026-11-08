import React from 'react';
import ReactDOM from 'react-dom/client';
import OperationsRoot from './src/OperationsRoot';
import { initializeAppearance } from '../web/src/appearance';
import { initializeLanguage } from '../web/src/i18n';
import '../web/src/styles.css';
import '../web/src/theme.css';

initializeAppearance();
initializeLanguage();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OperationsRoot />
  </React.StrictMode>,
);

import { Suspense } from 'react';
import PlatformRoot from '../PlatformRoot';
import { uiText } from './index';
import { useLanguage } from './useLanguage';

/** Rerender the existing tree on locale changes while preserving component keys and drafts. */
export function LocalizedRoot() {
  useLanguage();
  return (
    <Suspense
      fallback={
        <main className="loading-screen">
          <p>{uiText('common:loadingWorkspace')}</p>
        </main>
      }
    >
      <PlatformRoot />
    </Suspense>
  );
}

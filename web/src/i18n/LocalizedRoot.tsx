import { Suspense } from 'react';
import { LoadBoundary } from '../components/LoadBoundary';
import PlatformRoot from '../PlatformRoot';
import { uiText } from './account';
import { useLanguage } from './useLanguage';

/** Rerender the existing tree on locale changes while preserving component keys and drafts. */
export function LocalizedRoot() {
  useLanguage();
  return (
    <LoadBoundary>
      <Suspense
        fallback={
          <main className="loading-screen">
            <p>{uiText('common:loadingWorkspace')}</p>
          </main>
        }
      >
        <PlatformRoot />
      </Suspense>
    </LoadBoundary>
  );
}

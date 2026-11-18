import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WebsiteVersionChanges } from '../../../../web/src/components/WebsiteVersionChanges';
import {
  websiteProjectClient,
  type WebsiteProjectSummary,
  type WebsiteProjectVersion,
} from '../../../../web/src/websiteProjects';
import { initializeLanguage } from '../../../../web/src/i18n';
import '../../../../web/src/styles.css';
import '../../../../web/src/theme.css';

const fixture = (
  globalThis as unknown as {
    fixture: {
      before: WebsiteProjectVersion;
      after: WebsiteProjectSummary;
      workspaceId: string;
    };
  }
).fixture;
initializeLanguage().setLanguage('en');
const access = { workspaceId: fixture.workspaceId, userId: 'diff-owner', current: () => true };
function Fixture() {
  const [open, setOpen] = useState(true);
  const client = useMemo(() => websiteProjectClient(fixture.after, access), []);
  return (
    <main style={{ maxWidth: 680, margin: 'auto', padding: 16 }}>
      <button onClick={() => setOpen((value) => !value)}>Toggle comparison</button>
      {open && (
        <WebsiteVersionChanges
          project={fixture.after}
          previous={fixture.before}
          currentVersion={2}
          access={access}
          loadCurrent={client.manifest}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('fixture')!).render(<Fixture />);

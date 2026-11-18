import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { libraryItemKey, type LibraryItem, type LibraryPin } from '../../../../web/src/conversationLibrary';
import { initializeLanguage } from '../../../../web/src/i18n';
import { ConversationLibrary } from '../../../../web/src/workspace/details/ConversationLibrary';
import '../../../../web/src/styles.css';
import '../../../../web/src/theme.css';

const createdAt = '2026-11-11T09:00:00Z';
const files: LibraryItem[] = Array.from({ length: 7 }, (_, index) => {
  const target = `file-${index}`;
  const media = index === 6;
  const title = media ? 'Screenshot.png' : `Manual ${index + 1}.pdf`;
  const createdAt = `2026-11-11T09:0${index}:00Z`;
  return {
    kind: 'file',
    target,
    createdAt,
    title,
    media,
    sourceFile: {
      id: target,
      name: title,
      size: 1024,
      type: media ? 'image/png' : 'application/pdf',
      createdAt,
    },
  };
});
const items: LibraryItem[] = [
  ...files,
  {
    kind: 'link',
    target: 'https://example.test/reference',
    href: 'https://example.test/reference',
    createdAt: '2026-11-09T10:00:00Z',
    title: 'Weekly reference',
    messageId: 'weekly',
    media: false,
  },
  {
    kind: 'website',
    target: 'fixture-site',
    title: 'Earlier website',
    media: false,
    createdAt: '2026-11-08T10:00:00Z',
    message: {
      id: 'delivery',
      conversationId: 'fixture-chat',
      role: 'assistant',
      kind: 'website_project',
      content: 'Earlier website',
      createdAt: '2026-11-08T10:00:00Z',
      status: 'done',
    },
  },
];

function Fixture() {
  const [pins, setPins] = useState<LibraryPin[]>([]);
  const [pinState, setPinState] = useState<'ready' | 'error'>('ready');
  const [saving, setSaving] = useState<string>();
  return (
    <ConversationLibrary
      items={items}
      pins={pins}
      saving={saving}
      pinState={pinState}
      onPin={async (item, pinned) => {
        const { kind, target } = item;
        const id = libraryItemKey(item);
        setSaving(id);
        const response = await fetch('/fixture-pin', {
          method: 'PUT',
          body: JSON.stringify({ kind, target, pinned }),
        });
        if (response.ok) {
          setPins((previous) =>
            pinned
              ? [...previous, { kind, target, pinnedAt: createdAt }]
              : previous.filter((pin) => libraryItemKey(pin) !== id),
          );
        } else {
          setPinState('error');
        }
        setSaving(undefined);
      }}
      onRetry={() => setPinState('ready')}
      renderItem={(item) => (
        <button type="button" className="file-card">
          {item.title}
        </button>
      )}
      fileTools={<button type="button">Upload file</button>}
    />
  );
}

initializeLanguage().setLanguage(new URLSearchParams(location.search).has('zh') ? 'zh-CN' : 'en');
createRoot(document.getElementById('fixture')!).render(<Fixture />);

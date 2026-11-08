import { uiText } from '../../i18n';
import type { DetailTab } from '../types';
import './Details.css';

export function DetailTabs({
  value,
  group,
  onChange,
}: {
  value: DetailTab;
  group: boolean;
  onChange: (value: DetailTab) => void;
}) {
  const tabs: Array<[DetailTab, string]> = [
    ['details', uiText('workspace:text_979a332955c8')],
    ['files', uiText('workspace:text_433bdcb25776')],
    ['computer', uiText('workspace:detailComputerTab')],
    ['members', uiText(group ? 'workspace:text_6e6d6ddbb7c1' : 'workspace:text_7a6335b379b9')],
  ];
  return (
    <div
      className="detail-tabs detail-navigation-tabs"
      role="tablist"
      aria-label={uiText('workspace:text_f76cef9703c5')}
    >
      {tabs.map(([id, label], index) => (
        <button
          key={id}
          id={`detail-tab-${id}`}
          type="button"
          role="tab"
          tabIndex={value === id ? 0 : -1}
          aria-selected={value === id}
          aria-controls={`detail-content-${id}`}
          className={value === id ? 'active' : ''}
          onClick={() => onChange(id)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            onChange(tabs[next][0]);
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>(`#detail-tab-${tabs[next][0]}`)
              ?.focus();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

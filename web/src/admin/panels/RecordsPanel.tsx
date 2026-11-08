import { uiText } from '../../i18n';
import { useState } from 'react';
import { Card } from './AdminPrimitives';
import { RecordList } from './RecordList';
import { RunningList } from './RunningList';
import { AdminPanelProps } from './types';
export function RecordsPanel(props: AdminPanelProps) {
  const [filter, setFilter] = useState<'all' | 'error'>('all');
  const [conversation, setConversation] = useState('');
  const records = (
    filter === 'error'
      ? props.overview.execution.recentErrors
      : props.overview.execution.recentRecords
  ).filter((item) => !conversation || item.conversationId === conversation);
  return (
    <>
      <div className="admin-page-heading">
        <h2>{uiText('platform:text_6e55e0f207bf')}</h2>
        <p>{uiText('platform:text_2a9f0e6a41aa')}</p>
      </div>
      <Card title={uiText('platform:text_08b04e8ced83')}>
        <RunningList {...props} />
      </Card>
      <Card
        title={uiText('platform:text_d3d80eca1fd7')}
        description={uiText('platform:text_3b93abd4d8cd', {
          value0: props.overview.execution.recordLimit,
          value1: filter === 'error' ? uiText('platform:text_28384d7afd2e') : '',
          value2: conversation ? uiText('platform:text_2e1ec8f8a1b4') : '',
        })}
      >
        <div className="admin-section-tools">
          <div className="admin-filter-tabs" aria-label={uiText('platform:text_21de13f5e54d')}>
            {(['all', 'error'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
              >
                {item === 'all'
                  ? uiText('platform:text_e42579208480')
                  : uiText('platform:text_eff4912bbb0f')}
              </button>
            ))}
          </div>
          <select
            value={conversation}
            onChange={(event) => setConversation(event.target.value)}
            aria-label={uiText('platform:text_0db24603a35b')}
          >
            <option value="">{uiText('platform:text_73459f1c5f20')}</option>
            {props.data.conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
        <RecordList records={records} empty={uiText('platform:text_2f9ef0ee90a3')} />
      </Card>
    </>
  );
}

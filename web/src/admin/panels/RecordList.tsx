import { uiText } from '../../i18n';
import type { AdminExecutionRecord } from '../../../../shared/admin';
import { AdminEmpty, AdminStatus, adminTime, ConversationLink } from './AdminPrimitives';
export function RecordList({
  records,
  empty = uiText('platform:text_c82f6e36a15a'),
}: {
  records: AdminExecutionRecord[];
  empty?: string;
}) {
  if (!records.length)
    return <AdminEmpty detail={uiText('platform:text_55274615f286')}>{empty}</AdminEmpty>;
  return (
    <div className="admin-activity">
      {records.map((record) => (
        <article key={record.id}>
          <div className="admin-row">
            <div className="admin-row-copy">
              <strong>
                {record.agentName} <span aria-hidden="true">·</span> {record.conversationTitle}
              </strong>
              <small className="admin-record-time">
                {adminTime(record.createdAt)} ·{' '}
                {
                  {
                    text: uiText('platform:text_cf945e21ddef'),
                    activity: uiText('platform:text_2241135101b1'),
                    computer: uiText('platform:text_c9cf30817de5'),
                    approval: uiText('platform:text_544d9d796824'),
                  }[record.kind]
                }
              </small>
            </div>
            <AdminStatus
              tone={
                record.status === 'error' ? 'error' : record.status === 'running' ? 'working' : ''
              }
            >
              {record.kind === 'approval' && record.status === 'running'
                ? uiText('platform:text_150fec9297f2')
                : {
                    running: uiText('platform:text_5026a63b58cd'),
                    done: uiText('platform:text_f28461bb49c8'),
                    error: uiText('platform:text_9344597efd49'),
                  }[record.status]}
            </AdminStatus>
          </div>
          <p className="admin-detail-text">
            {record.summary || uiText('platform:text_dd4e2f63f1fe')}
          </p>
          <ConversationLink id={record.conversationId} messageId={record.id}>
            {uiText('platform:text_279a2bff98e0')}
          </ConversationLink>
        </article>
      ))}
    </div>
  );
}

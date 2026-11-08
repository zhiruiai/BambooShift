import { uiText } from '../../i18n';
import { Monitor } from 'lucide-react';
import { AdminStatus, Card } from './AdminPrimitives';
import { AdminPanelProps } from './types';
export function ComputerPanel({
  overview,
  data,
  conversationId,
  onConversationChange,
  onComputer,
}: AdminPanelProps) {
  const computer = overview.computer;
  return (
    <>
      <div className="admin-page-heading">
        <h2>{uiText('platform:text_6205c8a9a2b9')}</h2>
        <p>{uiText('platform:text_614d715096ff')}</p>
      </div>
      <Card
        title={computer.name}
        description={uiText('platform:text_56bcdaf9d1ce')}
        action={
          <AdminStatus tone={computer.connected ? '' : 'waiting'}>
            {computer.connected
              ? uiText('platform:text_5be0323e8adc')
              : uiText('platform:text_3d52574ce150')}
          </AdminStatus>
        }
      >
        <div className="admin-connection-card">
          <Monitor size={30} />
          <p>{computer.status}</p>
        </div>
        <dl className="admin-detail-grid">
          <div>
            <dt>{uiText('platform:text_485a26050ce5')}</dt>
            <dd>
              {computer.mode === 'remote'
                ? uiText('platform:text_3535087994d0')
                : uiText('platform:text_8a94c4a1cdbd')}
            </dd>
          </div>
          <div>
            <dt>{uiText('platform:text_573394a6e549')}</dt>
            <dd>
              {computer.surface === 'desktop'
                ? uiText('platform:text_5b096afbdb0c')
                : uiText('platform:text_162f582e1060')}
            </dd>
          </div>
          {computer.savedRemote && (
            <div>
              <dt>{uiText('platform:text_7e7fc0c52c54')}</dt>
              <dd>
                {computer.savedRemote.name}
                <small>{computer.savedRemote.url}</small>
              </dd>
            </div>
          )}
          <div>
            <dt>{uiText('platform:text_3e039203e357')}</dt>
            <dd>
              {uiText('platform:text_b712a281d951')}
              <small>{uiText('platform:text_7faee212701c')}</small>
            </dd>
          </div>
        </dl>
        <div className="admin-section-tools">
          <label>
            {uiText('platform:text_f4d360b28c34')}
            <select
              value={conversationId}
              onChange={(event) => onConversationChange(event.target.value)}
              disabled={!data.conversations.length}
            >
              {!data.conversations.length && (
                <option value="">{uiText('platform:text_69e71f0380ae')}</option>
              )}
              {data.conversations.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button" type="button" onClick={onComputer}>
            <Monitor size={15} />
            {uiText('platform:text_510e7927b89b')}
          </button>
        </div>
        <p className="field-help">{uiText('platform:text_d96d9aa5ed7d')}</p>
      </Card>
    </>
  );
}

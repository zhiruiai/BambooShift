import { uiText } from '../../i18n';
import { DeviceSettings } from '../../components/DeviceSettings';
import { Card } from './AdminPrimitives';
import { AdminPanelProps } from './types';
export function AccessPanel({ overview }: AdminPanelProps) {
  const deployment = overview.deployment;
  return (
    <>
      <div className="admin-page-heading">
        <h2>{uiText('platform:text_ba903aa19e03')}</h2>
        <p>{uiText('platform:text_b178e39bfa43')}</p>
      </div>
      <Card
        title={uiText('platform:text_2de94a43f369')}
        description={
          deployment.access === 'workspace-members'
            ? uiText('platform:text_dbdefee39368')
            : uiText('platform:text_1e2696e86307')
        }
      >
        <dl className="admin-detail-grid">
          <div>
            <dt>{uiText('platform:text_b9410a704545')}</dt>
            <dd>
              {deployment.mode === 'remote'
                ? uiText('platform:text_ce5a7298821d')
                : uiText('platform:text_17f273e83e0e')}
              <small>
                {deployment.authentication === 'accounts'
                  ? uiText('platform:text_ece1f4d489cb')
                  : deployment.authentication === 'paired-devices'
                    ? uiText('platform:text_631d812d7fd5')
                    : uiText('platform:text_e4e1c706b7f5')}
              </small>
            </dd>
          </div>
          <div>
            <dt>{uiText('platform:text_082315a546c2')}</dt>
            <dd>
              {uiText('platform:text_eed37b247c89')}
              <small>{uiText('platform:text_23d77adb0e44')}</small>
            </dd>
          </div>
          <div>
            <dt>{uiText('platform:text_275057e8b614')}</dt>
            <dd>
              SQLite<small>{uiText('platform:text_be0c233354a7')}</small>
            </dd>
          </div>
          {deployment.publicOrigin && (
            <div>
              <dt>{uiText('platform:text_be33dca4cee7')}</dt>
              <dd>{deployment.publicOrigin}</dd>
            </div>
          )}
        </dl>
        <DeviceSettings />
      </Card>
    </>
  );
}

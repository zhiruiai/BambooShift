import { uiText } from '../../i18n';
import { Settings, Sparkles } from 'lucide-react';
import { AdminEmpty, AdminStatus, Card } from './AdminPrimitives';
import { AdminPanelProps } from './types';
export function ModelsPanel({ overview, onModels }: AdminPanelProps) {
  const { models, settings } = overview;
  return (
    <>
      <div className="admin-page-heading">
        <h2>{uiText('platform:text_8cbcf741e727')}</h2>
        <p>{uiText('platform:text_ee0c1b9e2609')}</p>
      </div>
      <Card
        title={settings.profileName || uiText('platform:text_9c8a6854492c')}
        description={`${settings.provider} · ${settings.model}`}
        action={
          <button className="primary-button" type="button" onClick={onModels}>
            <Settings size={15} />
            {uiText('platform:text_a02b1b971d49')}
          </button>
        }
      >
        <dl className="admin-detail-grid">
          <div>
            <dt>{uiText('platform:text_82b7cf40b5e6')}</dt>
            <dd>
              {settings.configured
                ? uiText('platform:text_de8184da1ef8')
                : uiText('platform:text_f51bc1439591')}
              <small>{uiText('platform:text_a7eb5cb241c2')}</small>
            </dd>
          </div>
          <div>
            <dt>{uiText('platform:text_b4cc36ab4d2f')}</dt>
            <dd>
              {models.profiles.length}
              <small>{uiText('platform:text_662efc78b388')}</small>
            </dd>
          </div>
        </dl>
      </Card>
      <Card title={uiText('platform:text_35db9b0d801a')}>
        {models.profiles.length ? (
          <div className="admin-list">
            {models.profiles.map((profile) => (
              <div className="admin-row" key={profile.id}>
                <Sparkles size={20} />
                <div className="admin-row-copy">
                  <strong>{profile.name}</strong>
                  <small>
                    {profile.provider === 'deepseek'
                      ? uiText('platform:text_b5742e19a9a7')
                      : profile.provider}{' '}
                    · {profile.model}
                  </small>
                  <small>
                    {profile.credentialSource === 'saved'
                      ? uiText('platform:text_3d11209d320e')
                      : profile.credentialSource === 'environment'
                        ? uiText('platform:text_8e4c47649b08')
                        : profile.credentialSource === 'pi'
                          ? uiText('platform:text_2529d0569974')
                          : profile.configured
                            ? uiText('platform:text_5eeb7f337684')
                            : uiText('platform:text_f76931eb9b18')}
                  </small>
                  {profile.baseUrl && <small>{profile.baseUrl}</small>}
                </div>
                {profile.id === models.activeProfileId && (
                  <AdminStatus>{uiText('platform:text_f50585ee7631')}</AdminStatus>
                )}
              </div>
            ))}
          </div>
        ) : (
          <AdminEmpty icon={<Sparkles size={24} />}>
            {uiText('platform:text_b4d546eab805')}
          </AdminEmpty>
        )}
      </Card>
    </>
  );
}

import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Monitor, RefreshCw, Smartphone } from 'lucide-react';
import type { AccountDeviceSession } from '../../../shared/platform';
import type { MutationGate } from './accountActions';
import { platformApi, PlatformApiError, platformTime } from './platformApi';
import './Platform.css';
import './AccountSettings.css';

export function AccountDevices({
  userId,
  gate: sharedGate,
  onExpired,
  onIdentityChanged,
}: {
  userId: string;
  gate?: MutationGate;
  onExpired: () => void;
  onIdentityChanged: () => void;
}) {
  const [busy, setBusy] = useState(false),
    running = useRef(false);
  const gate: MutationGate = sharedGate || {
    busy,
    begin: () => {
      if (running.current) return false;
      running.current = true;
      setBusy(true);
      return true;
    },
    finish: () => {
      running.current = false;
      setBusy(false);
    },
  };
  const [devices, setDevices] = useState<AccountDeviceSession[] | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState(''),
    [notice, setNotice] = useState('');
  const sequence = useRef(0);
  async function load() {
    const request = ++sequence.current;
    setLoading(true);
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await platformApi<{ userId: string; sessions: AccountDeviceSession[] }>(
        '/account/sessions',
        'GET',
        undefined,
        { signal: controller.signal },
      );
      if (request === sequence.current) {
        if (result.userId !== userId) {
          setDevices(null);
          setConfirm('');
          setNotice('');
          setError(uiText('account:text_358d787d6b29'));
          onIdentityChanged();
          return;
        }
        setDevices(result.sessions);
        setError('');
      }
    } catch (cause) {
      if (request === sequence.current) {
        setError((cause as Error).message);
        if (cause instanceof PlatformApiError && cause.status === 401) {
          setDevices(null);
          onExpired();
        }
      }
    } finally {
      clearTimeout(timeout);
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, []);
  return (
    <section className="platform-section" aria-labelledby="account-devices-heading">
      <div className="platform-section-heading">
        <div>
          <h2 id="account-devices-heading">{uiText('account:text_cd438f5d0cca')}</h2>
          <p>{uiText('account:text_5a418f472542')}</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={loading || gate.busy}
          onClick={() => void load()}
        >
          {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          {uiText('account:text_aee887434131')}
        </button>
      </div>
      <div className="account-devices-body">
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="account-settings-saved" role="status">
            {notice}
          </p>
        )}
        {!devices && loading && (
          <p className="platform-help">{uiText('account:text_d03f8636d0fb')}</p>
        )}
        {devices?.length === 0 && (
          <p className="platform-help">{uiText('account:text_a4d805017812')}</p>
        )}
        {devices?.map((device) => (
          <div className="platform-member-row account-device-row" key={device.id}>
            {/手机/i.test(device.name) ? <Smartphone size={21} /> : <Monitor size={21} />}
            <div className="platform-member-copy">
              <strong>
                {device.name}
                {device.current && (
                  <span className="platform-inline-label">
                    {uiText('account:text_c68978537cf3')}
                  </span>
                )}
              </strong>
              <small>
                {uiText('account:text_18dc715ca37f')}
                {platformTime(device.createdAt)}
              </small>
              {confirm === device.id && (
                <div className="account-device-confirm">
                  <p>
                    {device.current
                      ? uiText('account:text_bcf85d8dbd62')
                      : uiText('account:text_c9d4d6555c23')}
                  </p>
                  <div>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={gate.busy}
                      onClick={() => setConfirm('')}
                    >
                      {uiText('account:text_2cd0f3be8738')}
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={gate.busy}
                      onClick={async () => {
                        if (!gate.begin()) return;
                        sequence.current++;
                        setError('');
                        setNotice('');
                        const controller = new AbortController(),
                          timeout = setTimeout(() => controller.abort(), 30000);
                        try {
                          await platformApi(
                            `/account/sessions/${encodeURIComponent(device.id)}`,
                            'DELETE',
                            { expectedUserId: userId },
                            { signal: controller.signal },
                          );
                          setConfirm('');
                          if (device.current) onExpired();
                          else {
                            setNotice(uiText('account:text_ef8c0923730e'));
                            await load();
                          }
                        } catch (cause) {
                          if (
                            cause instanceof PlatformApiError &&
                            [401, 409].includes(cause.status)
                          ) {
                            setDevices(null);
                            setConfirm('');
                            onIdentityChanged();
                          }
                          setError(
                            controller.signal.aborted
                              ? uiText('account:text_1cfca524bc41')
                              : (cause as Error).message,
                          );
                        } finally {
                          clearTimeout(timeout);
                          gate.finish();
                        }
                      }}
                    >
                      {uiText('account:text_8192e705f0b7')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {confirm !== device.id && (
              <button
                type="button"
                className="platform-text-button"
                disabled={gate.busy}
                onClick={() => setConfirm(device.id)}
              >
                {uiText('account:text_926a50b98ece')}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

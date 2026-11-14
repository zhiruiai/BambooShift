import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ModelProfilesResponse } from '../../../shared/types';
import { createAppConnectionScope } from '../appConnections';
import { uiText } from '../i18n';

type Props = {
  workspaceId?: string;
  userId?: string;
  value?: string | null;
  disabled?: boolean;
  onChange: (value: string | null) => void;
};

/** Choose an existing workspace profile without copying its credentials into the Bot. */
export function BotModelSelect(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createAppConnectionScope({ ...props, identity: () => latest.current }),
  );
  const [profiles, setProfiles] = useState<ModelProfilesResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const helpId = useId();
  const selected = profiles?.profiles.find((profile) => profile.id === props.value);
  const active = profiles?.profiles.find((profile) => profile.id === profiles.activeProfileId);
  const unavailable = !!props.value && !!profiles && !selected?.configured;

  async function load() {
    const ticket = scope.ticket();
    if (!scope.current(ticket)) return;
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await scope.request<ModelProfilesResponse>('/model-profiles');
      if (request === sequence.current && scope.current(ticket)) setProfiles(result);
    } catch (cause) {
      if (request === sequence.current && scope.current(ticket)) setError((cause as Error).message);
    } finally {
      if (request === sequence.current && scope.current(ticket)) setLoading(false);
    }
  }

  useEffect(() => {
    scope.resume();
    void load();
    return () => {
      sequence.current++;
      scope.suspend();
    };
  }, [scope]);

  return (
    <div className="bot-model-selection" aria-busy={loading}>
      <label>
        {uiText('settings:botModelLabel')}
        <select
          value={props.value || ''}
          disabled={props.disabled || loading || !!error}
          aria-describedby={helpId}
          aria-invalid={unavailable || undefined}
          onChange={(event) => {
            const id = event.target.value;
            if (
              latest.current.disabled ||
              loading ||
              error ||
              !scope.current(scope.ticket()) ||
              (id && !profiles?.profiles.some((profile) => profile.id === id && profile.configured))
            )
              return;
            latest.current.onChange(id || null);
          }}
        >
          <option value="">
            {uiText('settings:botModelDefault')}
            {active?.configured ? ` · ${active.name} · ${active.model}` : ''}
          </option>
          {props.value && !selected && (
            <option value={props.value} disabled>
              {uiText(loading ? 'settings:botModelLoading' : 'settings:botModelUnavailable')}
            </option>
          )}
          {profiles?.profiles.map((profile) => (
            <option key={profile.id} value={profile.id} disabled={!profile.configured}>
              {profile.name} · {profile.provider} · {profile.model}
              {!profile.configured ? ` · ${uiText('settings:botModelNotConfigured')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <p className={unavailable ? 'error-text' : 'field-help'} id={helpId}>
        {uiText(unavailable ? 'settings:botModelUnavailableHelp' : 'settings:botModelHelp')}
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && !profiles?.profiles.some((profile) => profile.configured) && (
        <p className="field-help">{uiText('settings:botModelEmpty')}</p>
      )}
      <button
        type="button"
        className="text-button"
        disabled={props.disabled || loading}
        onClick={() => void load()}
      >
        <RefreshCw size={14} aria-hidden="true" />
        {uiText('settings:botModelRefresh')}
      </button>
    </div>
  );
}

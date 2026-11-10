import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardCopy, Link2, Loader2 } from 'lucide-react';
import { isComputerOperationId } from '../../../../shared/computer-operations';
import { uiText } from '../../i18n';
import { serviceText } from '../../i18n/serviceText';
import type { ComputerDialogModel } from './types';

type PairingCheck = {
  topology: 'shared' | 'pool' | 'legacy';
  browser: 'supported' | 'unavailable' | 'perScreen';
  desktop: 'ready' | 'notReady' | 'unavailable' | 'perScreen';
};

const setupGuide =
  'https://github.com/zhiruiai/PandaMate/blob/main/docs/computer.md#%E7%8B%AC%E7%AB%8B-worker';
const browserState = {
  supported: 'computer:pair_browser_supported',
  unavailable: 'computer:pair_browser_unavailable',
  perScreen: 'computer:pair_per_screen',
} as const;
const desktopState = {
  ready: 'computer:pair_desktop_ready',
  notReady: 'computer:pair_desktop_permissions',
  unavailable: 'computer:pair_desktop_unavailable',
  perScreen: 'computer:pair_per_screen',
} as const;

function workerAddress(raw: string) {
  const address = raw.trim();
  if (!/^https?:\/\//i.test(address) || address.length > 2048 || /[?#\s]/.test(address)) return;
  try {
    const url = new URL(address);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!url.hostname || url.username || url.password) return;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return address;
  } catch {
    // Keep incomplete addresses editable until the user supplies a valid one.
  }
}

export function ComputerWorkerPairing({
  model: { identity, remote, token, remoteEdited, setRemote, setToken, scope },
  disabled,
  connecting,
  onConnect,
}: {
  model: Pick<
    ComputerDialogModel,
    'identity' | 'remote' | 'token' | 'remoteEdited' | 'setRemote' | 'setToken' | 'scope'
  >;
  disabled: boolean;
  connecting: boolean;
  onConnect: (url: string, token: string) => void;
}) {
  const [native, setNative] = useState(false);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [check, setCheck] = useState<PairingCheck>();
  const [checkError, setCheckError] = useState('');
  const [checking, setChecking] = useState(false);
  const checkVersion = useRef(0);
  useEffect(
    () => () => {
      checkVersion.current++;
    },
    [],
  );
  const workspaceId = identity.current.workspaceId;
  const command = isComputerOperationId(workspaceId)
    ? `npm run computer:pair -- --workspace ${workspaceId}${native ? ' --desktop' : ''}`
    : undefined;
  const url = workerAddress(remote);
  const ready = !!url && !!token.trim() && !disabled && !checking;

  function resetCheck() {
    checkVersion.current++;
    setChecking(false);
    setCheck(undefined);
    setCheckError('');
  }
  async function checkConnection() {
    const ticket = scope.ticket();
    if (!url || !ready || !scope.current(ticket)) return;
    const attempt = ++checkVersion.current;
    const current = () => checkVersion.current === attempt && scope.current(ticket);
    setChecking(true);
    setCheck(undefined);
    setCheckError('');
    try {
      const result = await scope.request<PairingCheck>(
        '/connect/check',
        'POST',
        { url, token },
        true,
      );
      if (current()) setCheck(result);
    } catch (error) {
      if (current()) setCheckError(serviceText((error as Error).message));
    } finally {
      if (checkVersion.current === attempt) setChecking(false);
    }
  }
  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <>
      <details className="computer-pair-guide">
        <summary>{uiText('computer:pair_setup')}</summary>
        <ol>
          <li>{uiText('computer:pair_install')}</li>
          <li>
            {uiText('computer:pair_run_command')}
            {command && (
              <>
                <label className="computer-pair-native">
                  <input
                    type="checkbox"
                    checked={native}
                    onChange={(event) => {
                      setNative(event.target.checked);
                      setCopy('idle');
                    }}
                  />
                  {uiText('computer:pair_include_desktop')}
                </label>
                {native && <p>{uiText('computer:pair_desktop_setup')}</p>}
                <div className="computer-pair-command">
                  <code>{command}</code>
                  <button type="button" className="text-button" onClick={() => void copyCommand()}>
                    {copy === 'copied' ? <Check size={14} /> : <ClipboardCopy size={14} />}
                    {uiText(copy === 'copied' ? 'computer:pair_copied' : 'computer:pair_copy')}
                  </button>
                </div>
                {copy === 'failed' && <p role="status">{uiText('computer:pair_copy_failed')}</p>}
              </>
            )}
          </li>
          <li>{uiText('computer:pair_use_output')}</li>
        </ol>
        <p>{uiText('computer:pair_network')}</p>
        <p>{uiText('computer:pair_origin')}</p>
        <a href={setupGuide} target="_blank" rel="noreferrer">
          {uiText('computer:location_setup_guide')}
        </a>
      </details>
      <form
        className="computer-location-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (url && ready) onConnect(url, token);
        }}
      >
        <label>
          {uiText('computer:text_06488c0767c9')}
          <input
            type="url"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={disabled || checking}
            value={remote}
            onChange={(event) => {
              remoteEdited.current = true;
              setRemote(event.target.value);
              resetCheck();
            }}
            placeholder="https://"
            maxLength={2048}
            aria-describedby="computer-worker-address-help"
            aria-invalid={!!remote.trim() && !url}
          />
        </label>
        <label>
          {uiText('computer:location_credential')}
          <input
            type="password"
            required
            disabled={disabled || checking}
            autoComplete="off"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              resetCheck();
            }}
          />
        </label>
        <p id="computer-worker-address-help">{uiText('computer:pair_address_help')}</p>
        <div className="computer-location-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!ready}
            onClick={() => void checkConnection()}
          >
            {checking && <Loader2 size={14} className="spin" aria-hidden="true" />}
            {uiText(checking ? 'computer:pair_checking' : 'computer:pair_check')}
          </button>
          <button type="submit" className="primary-button" disabled={!ready}>
            {connecting ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />}
            {uiText(connecting ? 'computer:text_8be0ea36a9bb' : 'computer:location_connect_remote')}
          </button>
        </div>
      </form>
      {check && (
        <div className="computer-pair-result" role="status">
          <strong>{uiText('computer:pair_checked')}</strong>
          <p>
            {check.browser === 'perScreen' && check.desktop === 'perScreen'
              ? uiText('computer:pair_per_screen')
              : `${uiText(browserState[check.browser])} · ${uiText(desktopState[check.desktop])}`}
          </p>
        </div>
      )}
      {checkError && (
        <div className="computer-pair-result" role="alert">
          <strong>{uiText('computer:pair_check_failed')}</strong>
          <p>{checkError}</p>
          <p>{uiText('computer:pair_recovery')}</p>
        </div>
      )}
    </>
  );
}

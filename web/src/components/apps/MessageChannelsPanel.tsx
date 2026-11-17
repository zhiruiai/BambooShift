import { useState } from 'react';
import { ArrowUpRight, Check, Copy, MessageCircle, ShieldCheck } from 'lucide-react';
import providers from '../../../../shared/im-channel-providers.json';
import { currentLanguage, uiText } from '../../i18n';
import './MessageChannelsPanel.css';

export function MessageChannelsPanel() {
  const [selected, setSelected] = useState('feishu');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const provider = providers.find((item) => item.id === selected)!;
  const language = currentLanguage();
  const checkCommand = 'node server/workers/im-runtime/cli.mjs --check --config /private/im.json';
  async function copy() {
    try {
      await navigator.clipboard.writeText(checkCommand);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }
  return (
    <section className="message-channels" aria-label={uiText('workspace:messageChannelsTitle')}>
      <p className="message-channels-intro">{uiText('workspace:messageChannelsIntro')}</p>
      <div
        className="message-channel-options"
        role="tablist"
        aria-label={uiText('workspace:messageChannelsChoose')}
      >
        {providers.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === selected}
            className={`message-channel-option message-channel-${item.id}`}
            onClick={() => {
              setSelected(item.id);
              setCopied(false);
              setCopyFailed(false);
            }}
          >
            <span className="message-channel-icon">
              <MessageCircle size={22} aria-hidden="true" />
            </span>
            <strong>{item.name[language]}</strong>
            <small>{uiText('workspace:messageChannelsNeedsSetup')}</small>
          </button>
        ))}
      </div>
      <div className="message-channel-detail" role="tabpanel" aria-label={provider.name[language]}>
        <header>
          <div>
            <h3>{uiText('workspace:messageChannelsConnect', { name: provider.name[language] })}</h3>
            <p>{uiText('workspace:messageChannelsFlow')}</p>
          </div>
          <span className="message-channel-status">
            {uiText('workspace:messageChannelsDeveloper')}
          </span>
        </header>
        <ol className="message-channel-steps">
          <li>
            <span>1</span>
            <div>
              <strong>{uiText('workspace:messageChannelsStep1')}</strong>
              <p>
                {uiText(
                  provider.id === 'feishu'
                    ? 'workspace:messageChannelsCredentials_feishu'
                    : provider.id === 'dingtalk'
                      ? 'workspace:messageChannelsCredentials_dingtalk'
                      : 'workspace:messageChannelsCredentials_wecom',
                )}
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>{uiText('workspace:messageChannelsStep2')}</strong>
              <p>{uiText('workspace:messageChannelsBinding')}</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>{uiText('workspace:messageChannelsStep3')}</strong>
              <p>{uiText('workspace:messageChannelsVerification')}</p>
            </div>
          </li>
        </ol>
        <div className="message-channel-boundary">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>{uiText('workspace:messageChannelsBoundary')}</p>
        </div>
        <footer>
          <a
            className="primary-button"
            href={provider.documentation}
            target="_blank"
            rel="noopener noreferrer"
          >
            {uiText('workspace:messageChannelsGuide')}
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <button className="secondary-button" type="button" onClick={() => void copy()}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {uiText(copied ? 'workspace:messageChannelsCopied' : 'workspace:messageChannelsCopy')}
          </button>
        </footer>
        {copyFailed && (
          <p className="field-help" role="status">
            {checkCommand}
          </p>
        )}
        <details className="message-channel-technical">
          <summary>{uiText('workspace:messageChannelsTechnical')}</summary>
          <p>
            {provider.sdk.package} · {provider.sdk.version} · {provider.sdk.license}
          </p>
          <p>{uiText('workspace:messageChannelsProtocol')}</p>
          <a href={provider.upstream} target="_blank" rel="noopener noreferrer">
            {uiText('workspace:messageChannelsUpstream')}
          </a>
        </details>
      </div>
    </section>
  );
}

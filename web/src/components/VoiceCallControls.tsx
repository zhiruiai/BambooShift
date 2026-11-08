import { AudioLines, Mic, MicOff, PhoneOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Message } from '../../../shared/types';
import { uiText } from '../i18n';
import type { WorkspaceVoiceCall } from '../useVoiceCall';
import type { WorkspaceVoice } from '../useVoice';
import { validVoiceCallId, voiceTranscript } from '../voiceCallTransport';
import { IconButton, Dialog } from './UI';
import { VoiceMessageButton } from './VoiceControls';
import './VoiceCallControls.css';

export function VoiceCallStart({ call }: { call: WorkspaceVoiceCall }) {
  const [review, setReview] = useState(false);
  useEffect(() => {
    if (!call.canStart) setReview(false);
  }, [call.canStart]);
  if (!call.visible || call.active) return null;
  return (
    <>
      <IconButton
        className="voice-call-start"
        label={uiText('workspace:voiceCallStart')}
        disabled={!call.canStart}
        onClick={() => setReview(true)}
      >
        <AudioLines size={17} aria-hidden="true" />
      </IconButton>
      {review && call.canStart && (
        <Dialog title={uiText('workspace:voiceCallStart')} onClose={() => setReview(false)} portal>
          <div className="voice-call-consent">
            <p>{uiText('workspace:voiceCallConsent')}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setReview(false);
                call.start();
              }}
            >
              {uiText('workspace:voiceCallStart')}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

const labels = {
  idle: 'voiceCallTitle',
  connecting: 'voiceCallConnecting',
  listening: 'voiceCallListening',
  transcribing: 'voiceCallTranscribing',
  waiting: 'voiceCallWaiting',
  speaking: 'voiceCallSpeaking',
  paused: 'voiceCallPaused',
  ending: 'voiceCallEnding',
} as const;
const errors = {
  microphone: 'voiceCallMicrophone',
  denied: 'voiceCallDenied',
  noMicrophone: 'voiceCallNoMicrophone',
  unavailable: 'voiceCallUnavailable',
  unconfirmed: 'voiceCallUnconfirmed',
  busy: 'voiceCallBusy',
  reply: 'voiceCallReplyError',
  playback: 'voiceCallPlaybackError',
  ended: 'voiceCallEnded',
} as const;

function VoiceTranscript({
  turns,
  speaker,
  voice,
  current,
}: {
  turns: Message[];
  speaker(message: Message): string;
  voice?: WorkspaceVoice;
  current?: () => boolean;
}) {
  return (
    <details className="voice-call-transcript">
      <summary>{uiText('workspace:voiceCallTranscript')}</summary>
      {turns.length ? (
        <ol>
          {turns.map((message) => (
            <li key={message.id}>
              <div>
                <strong>{speaker(message)}</strong>
                {voice && (
                  <VoiceMessageButton voice={voice} message={message} onActivate={current} />
                )}
              </div>
              <p>{message.content}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p>{uiText('workspace:voiceCallNoTranscript')}</p>
      )}
    </details>
  );
}

export function ActiveVoiceCall({
  call,
  agentName,
  voice,
}: {
  call: WorkspaceVoiceCall;
  agentName?: string;
  voice: WorkspaceVoice;
}) {
  const { state } = call;
  const [settings, setSettings] = useState(false);
  if (!call.active && !state.error) return null;
  const error = state.error && uiText(`workspace:${errors[state.error]}`);
  return (
    <section className="voice-call-panel" aria-label={uiText('workspace:voiceCallTitle')}>
      <div className="voice-call-bar">
        <AudioLines size={18} aria-hidden="true" />
        <div className="voice-call-label">
          <strong>
            {uiText('workspace:voiceCallTitle')}
            {agentName ? ` · ${agentName}` : ''}
          </strong>
          <span role="status">
            {error ||
              uiText(
                `workspace:${state.muted && state.phase === 'listening' ? 'voiceCallMuted' : labels[state.phase]}`,
              )}
          </span>
        </div>
        {call.active && (
          <div className="voice-call-actions">
            {(state.phase === 'paused' || state.phase === 'speaking') && (
              <button type="button" className="text-button" onClick={call.resume}>
                {uiText(
                  `workspace:${state.phase === 'speaking' ? 'voiceCallInterrupt' : 'voiceCallContinue'}`,
                )}
              </button>
            )}
            <IconButton
              label={uiText(`workspace:${state.muted ? 'voiceCallUnmute' : 'voiceCallMute'}`)}
              disabled={state.phase === 'ending'}
              onClick={call.mute}
            >
              {state.muted ? <MicOff size={17} /> : <Mic size={17} />}
            </IconButton>
            <IconButton
              className="voice-call-end"
              label={uiText('workspace:voiceCallHangup')}
              disabled={state.phase === 'ending'}
              onClick={call.end}
            >
              <PhoneOff size={17} />
            </IconButton>
          </div>
        )}
      </div>
      {state.call && (
        <>
          <VoiceTranscript
            turns={call.turns}
            speaker={(message) =>
              message.role === 'user'
                ? uiText('workspace:voiceCallYou')
                : agentName || uiText('workspace:voiceCallBot')
            }
          />
          <button
            type="button"
            className="text-button voice-call-settings-button"
            aria-expanded={settings}
            onClick={() => setSettings((value) => !value)}
          >
            {uiText('workspace:voiceSettings')}
          </button>
          {settings && (
            <div className="voice-call-settings">
              <label>
                {uiText('workspace:voiceVoice')}
                <select
                  value={voice.state.voiceURI}
                  onChange={(event) => voice.update({ voiceURI: event.target.value })}
                >
                  <option value="">{uiText('workspace:voiceAutomatic')}</option>
                  {voice.state.voices.map((item) => (
                    <option key={item.voiceURI} value={item.voiceURI}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {uiText('workspace:voiceRate')}
                <select
                  value={voice.state.rate}
                  onChange={(event) => voice.update({ rate: Number(event.target.value) })}
                >
                  {[...new Set([0.75, 1, 1.25, 1.5, voice.state.rate])]
                    .sort((left, right) => left - right)
                    .map((rate) => (
                      <option key={rate} value={rate}>
                        {rate}×
                      </option>
                    ))}
                </select>
              </label>
              <span>{uiText('workspace:voiceCallAutoLanguage')}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function VoiceCallCard({
  message,
  messages,
  voice,
  current,
  speaker,
}: {
  message: Message;
  messages: Message[];
  voice: WorkspaceVoice;
  current(): boolean;
  speaker(message: Message): string;
}) {
  const record = message.metadata?.voiceCall as { id?: unknown; durationMs?: unknown } | undefined;
  if (
    !record ||
    !validVoiceCallId(record.id) ||
    typeof record.durationMs !== 'number' ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  )
    return null;
  const seconds = Math.floor(record.durationMs / 1000);
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const turns = message.userId
    ? voiceTranscript(messages, {
        id: record.id,
        conversationId: message.conversationId,
        userId: message.userId,
        agentId: message.agentId,
      })
    : [];
  return (
    <div className="voice-call-card">
      <strong>
        <AudioLines size={15} aria-hidden="true" /> {uiText('workspace:voiceCallTitle')} ·{' '}
        {duration}
      </strong>
      <VoiceTranscript turns={turns} speaker={speaker} voice={voice} current={current} />
    </div>
  );
}

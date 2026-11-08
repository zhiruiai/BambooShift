import { uiText, languageHeaders } from './i18n';
import { ApiError, api } from './api';
import { currentWorkspaceId, workspaceApiUrl } from './workspace-scope';
import { SPEECH_BYTES, SPEECH_SECONDS } from './speechAudio';
import { SPEECH_LIMITS, type SpeechStatus, type SpeechTranscription } from '../../shared/speech';

export type { SpeechStatus } from '../../shared/speech';
export async function speechStatus(signal: AbortSignal): Promise<SpeechStatus> {
  const status = await api<SpeechStatus>('/speech/status', 'GET', undefined, { signal });
  if (
    typeof status?.available !== 'boolean' ||
    status.format !== SPEECH_LIMITS.format ||
    status.processing !== SPEECH_LIMITS.processing ||
    (status.reason !== undefined && typeof status.reason !== 'string') ||
    status.maxSeconds !== SPEECH_SECONDS ||
    status.maxBytes !== SPEECH_BYTES
  )
    throw new Error(uiText('common:text_f0de922ea80c'));
  return status;
}
export async function transcribeSpeech(
  blob: Blob,
  signal: AbortSignal,
  userId?: string,
  voiceCallId?: string,
): Promise<string> {
  if (blob.type !== 'audio/wav' || blob.size < 46 || blob.size > SPEECH_BYTES)
    throw new Error(uiText('common:text_6ec8b187e776'));
  let response: Response;
  try {
    response = await fetch(workspaceApiUrl('/api/speech/transcribe'), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: {
        ...languageHeaders(),
        'Content-Type': 'audio/wav',
        ...(userId ? { 'X-OpenBot-Expected-User': userId } : {}),
        ...(voiceCallId ? { 'X-OpenBot-Voice-Call': voiceCallId } : {}),
      },
      body: blob,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError(uiText('common:text_9360e2a8b3eb'), 0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (response.status === 401)
      window.dispatchEvent(
        new Event(currentWorkspaceId() ? 'openbot:account-expired' : 'openbot:unpaired'),
      );
    if (response.status === 403 && currentWorkspaceId())
      window.dispatchEvent(new Event('openbot:revalidate'));
    throw new ApiError(
      typeof result.error === 'string'
        ? result.error
        : uiText('common:text_b50582a0d55e', { value0: response.status }),
      response.status,
      typeof result.code === 'string' ? result.code : undefined,
    );
  }
  const result: SpeechTranscription = await response.json();
  if (signal.aborted) throw new DOMException(uiText('common:text_d09ddef05902'), 'AbortError');
  if (userId && result?.userId !== userId) throw new Error(uiText('common:text_d7f22ae06017'));
  if (
    typeof result?.text !== 'string' ||
    result.text.length > 30000 ||
    !Number.isFinite(result.durationMs) ||
    result.durationMs < 0 ||
    result.durationMs > 60000
  )
    throw new Error(uiText('common:text_bcc34236f848'));
  const text = result.text.trim();
  if (!text) throw new Error(uiText('common:text_6b75f5928c87'));
  return text;
}

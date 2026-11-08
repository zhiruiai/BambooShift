export const SPEECH_LIMITS = {
  maxSeconds: 60,
  maxBytes: 2 * 1024 * 1024,
  format: 'wav-pcm16-mono-16000',
  processing: 'server-local',
} as const;

export interface SpeechStatus {
  available: boolean;
  reason?: string;
  maxSeconds: 60;
  maxBytes: number;
  format: 'wav-pcm16-mono-16000';
  processing: 'server-local';
}
export interface SpeechTranscription {
  text: string;
  durationMs: number;
  userId?: string;
}

import type { Message, VoiceMemo, WorkspaceFile } from '../../shared/types';
import { previewFilePath, readBoundedBody, type FilePreviewIdentity } from './filePreview';

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_DURATION_MS = 60_000;
const MAX_TRANSCRIPT = 500;
const SAMPLE_RATE = 16_000;
const WAV_MIME = 'audio/wav';
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const digest = /^[a-f0-9]{64}$/;

type VoiceMemoAudio = Pick<WorkspaceFile, 'id' | 'size'> & { sha256: string };

export function messageVoiceMemo(
  message: Message,
  files: WorkspaceFile[],
): (VoiceMemo & { audio?: VoiceMemoAudio }) | undefined {
  if (message.role !== 'assistant' || message.kind !== 'file' || message.status === 'error') return;
  const meta = message.metadata;
  const raw = meta?.voiceMemo;
  if (!raw || typeof raw !== 'object') return;
  const { transcript, durationMs } = raw as Partial<VoiceMemo>;
  if (
    typeof transcript !== 'string' ||
    !transcript.trim() ||
    transcript.length > MAX_TRANSCRIPT ||
    typeof durationMs !== 'number' ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > MAX_DURATION_MS
  )
    return;
  const memo = { transcript, durationMs };
  const { fileId, name, size, sha256 } = meta!;
  if (
    typeof fileId !== 'string' ||
    !identifier.test(fileId) ||
    typeof name !== 'string' ||
    !name.toLowerCase().endsWith('.wav') ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 44 ||
    size > MAX_AUDIO_BYTES ||
    typeof sha256 !== 'string' ||
    !digest.test(sha256)
  )
    return memo;
  const file = files.find((item) => item.id === fileId);
  if (
    file?.name !== name ||
    file.size !== size ||
    file.sha256 !== sha256 ||
    file.type !== WAV_MIME ||
    file.conversationId !== message.conversationId
  )
    return memo;
  return { ...memo, audio: { id: file.id, size, sha256 } };
}

export function voiceMemoTime(seconds: number) {
  const total = Math.floor(Math.max(0, seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function wavDuration(bytes: Uint8Array) {
  if (bytes.length < 44) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (offset: number) => view.getUint32(offset);
  if (
    word(0) !== 0x52494646 ||
    word(8) !== 0x57415645 ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return;
  let hasFormat = false;
  let samples: number | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.length) return;
    switch (word(offset)) {
      case 0x666d7420:
        if (
          hasFormat ||
          length < 16 ||
          view.getUint16(start, true) !== 1 ||
          view.getUint16(start + 2, true) !== 1 ||
          view.getUint32(start + 4, true) !== SAMPLE_RATE ||
          view.getUint32(start + 8, true) !== SAMPLE_RATE * 2 ||
          view.getUint16(start + 12, true) !== 2 ||
          view.getUint16(start + 14, true) !== 16
        )
          return;
        hasFormat = true;
        break;
      case 0x64617461:
        if (samples !== undefined || !length || length % 2) return;
        samples = length / 2;
        break;
    }
    offset = start + length + (length % 2);
  }
  return hasFormat && samples ? (samples * 1000) / SAMPLE_RATE : undefined;
}

export async function loadVoiceMemo(
  audio: VoiceMemoAudio,
  durationMs: number,
  identity: FilePreviewIdentity,
  signal: AbortSignal,
  current: () => boolean,
  fetchAudio: typeof fetch = fetch,
) {
  const { workspaceId, userId } = identity;
  const path = previewFilePath(
    `/api/workspaces/${workspaceId}/files/${audio.id}/download`,
    identity,
  );
  const check = () => {
    if (signal.aborted || !current()) throw new Error('Voice memo scope changed');
  };
  if (!path || !userId) throw new Error('Invalid voice memo scope');
  check();
  const response = await fetchAudio(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    headers: { 'X-OpenBot-Expected-User': userId },
  });
  try {
    check();
    if (
      !response.ok ||
      response.redirected ||
      response.headers.get('content-type')?.trim().toLowerCase() !== WAV_MIME ||
      !/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') || '')
    )
      throw new Error('Invalid voice memo response');
    const bytes = await readBoundedBody(response, audio.size, check);
    const actualDuration = wavDuration(bytes);
    if (
      bytes.length !== audio.size ||
      actualDuration === undefined ||
      actualDuration > MAX_DURATION_MS ||
      Math.abs(actualDuration - durationMs) >= 1
    )
      throw new Error('Invalid voice memo audio');
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    check();
    if (sha256 !== audio.sha256) throw new Error('Voice memo did not match the delivery');
    return new Blob([bytes], { type: WAV_MIME });
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}

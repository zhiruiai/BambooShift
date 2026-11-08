import { uiText } from './i18n';
import type { ComposerState } from './chatDrafts';
import { audioError, type AudioRecorder, type RecorderCallbacks } from './speechAudio';

export type DictationCapture = {
  scope: string;
  userId?: string;
  conversationId: string;
  draft: ComposerState;
  selection: { start: number; end: number; version: number };
};
export type DictationState = {
  phase: 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error';
  durationMs: number;
  error: string;
  notice: string;
};
export const emptyDictation = (): DictationState => ({
  phase: 'idle',
  durationMs: 0,
  error: '',
  notice: '',
});
export function mergeDictation(
  current: ComposerState,
  capture: DictationCapture,
  text: string,
  selectionVersion: number,
): ComposerState {
  const { start, end, version } = capture.selection;
  const original =
    current === capture.draft &&
    version === selectionVersion &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= current.text.length;
  return {
    ...current,
    text: original
      ? current.text.slice(0, start) + text + current.text.slice(end)
      : current.text + (current.text && !/\s$/.test(current.text) ? '\n' : '') + text,
  };
}

export function createDictationController(options: {
  currentScope(): string;
  recorder(callbacks: RecorderCallbacks): AudioRecorder;
  transcribe(blob: Blob, signal: AbortSignal, userId?: string): Promise<string>;
  onTranscript(capture: DictationCapture, text: string): string | void;
  onState(state: DictationState): void;
  timeoutMs?: number;
}) {
  let state = emptyDictation();
  let generation = 0;
  let current:
    | { token: number; capture: DictationCapture; recorder: AudioRecorder; abort: AbortController }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: DictationState) => {
    state = next;
    options.onState(next);
  };
  const active = (token: number) =>
    current?.token === token &&
    token === generation &&
    current.capture.scope === options.currentScope();
  function cancel(notice = '') {
    generation++;
    clearTimeout(timer);
    const previous = current;
    current = undefined;
    previous?.abort.abort();
    previous?.recorder.cancel();
    publish({ ...emptyDictation(), notice });
  }
  function fail(token: number, error: unknown) {
    if (!active(token)) return;
    cancel();
    publish({ ...emptyDictation(), phase: 'error', error: audioError(error) });
  }
  async function finish() {
    const run = current;
    if (!run || !active(run.token) || state.phase !== 'recording') return;
    publish({ ...state, phase: 'transcribing' });
    clearTimeout(timer);
    timer = setTimeout(
      () => fail(run.token, new Error(uiText('common:text_300286de981a'))),
      options.timeoutMs ?? 180000,
    );
    try {
      const blob = await run.recorder.finish();
      if (!active(run.token)) return;
      const text = await options.transcribe(blob, run.abort.signal, run.capture.userId);
      if (!active(run.token)) return;
      const notice = options.onTranscript(run.capture, text) || uiText('common:text_c0348872bf3c');
      cancel(notice);
    } catch (error) {
      fail(run.token, error);
    }
  }
  return {
    get state() {
      return state;
    },
    get busy() {
      return !!current;
    },
    async start(capture: DictationCapture) {
      if (current || !capture.scope || capture.scope !== options.currentScope()) return;
      const token = ++generation;
      const recorder = options.recorder({
        onTime: (durationMs) => {
          if (!active(token)) return;
          const next = { ...state, durationMs };
          if (Math.floor(durationMs / 1000) !== Math.floor(state.durationMs / 1000)) publish(next);
          else state = next;
        },
        onLimit: () => {
          if (active(token)) void finish();
        },
        onError: (error) => fail(token, error),
      });
      current = { token, capture, recorder, abort: new AbortController() };
      publish({ ...emptyDictation(), phase: 'requesting' });
      timer = setTimeout(() => fail(token, new Error(uiText('common:text_e191cd916993'))), 60000);
      try {
        await recorder.start();
        if (!active(token)) {
          recorder.cancel();
          return;
        }
        clearTimeout(timer);
        publish({ ...state, phase: 'recording' });
      } catch (error) {
        fail(token, error);
      }
    },
    finish,
    cancel,
    error(message: string) {
      if (!current) publish({ ...emptyDictation(), phase: 'error', error: message });
    },
  };
}

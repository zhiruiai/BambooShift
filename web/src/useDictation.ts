import { uiText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { audioSupportError, createAudioRecorder } from './speechAudio';
import { speechStatus, transcribeSpeech, type SpeechStatus } from './speech';
import { createDictationController, emptyDictation, type DictationCapture } from './dictation';

export function useDictation(options: {
  scope: string;
  enabled: boolean;
  onTranscript(capture: DictationCapture, text: string): string | void;
  onInvalidate?(): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const [state, setState] = useState(emptyDictation);
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [controller] = useState(() =>
    createDictationController({
      currentScope: () => (mounted.current && latest.current.enabled ? latest.current.scope : ''),
      recorder: createAudioRecorder,
      transcribe: transcribeSpeech,
      onTranscript: (capture, text) => latest.current.onTranscript(capture, text),
      onState: (value) => {
        if (mounted.current) setState(value);
      },
    }),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.cancel();
      latest.current.onInvalidate?.();
    };
  }, [controller]);
  useEffect(() => {
    controller.cancel();
    latest.current.onInvalidate?.();
  }, [controller, options.scope, options.enabled]);
  useEffect(() => {
    const abort = new AbortController();
    let alive = true;
    setStatus(null);
    setStatusError('');
    const timeout = setTimeout(() => abort.abort(), 10000);
    void speechStatus(abort.signal)
      .then((value) => {
        if (alive && !abort.signal.aborted) {
          setStatus(value);
          if (statusAttempt && !controller.busy) {
            if (value.available) controller.cancel(uiText('common:text_b8173d4a100d'));
            else controller.error(value.reason || uiText('common:text_085f7aa095cb'));
          }
        }
      })
      .catch((error: unknown) => {
        if (alive && mounted.current)
          setStatusError(
            abort.signal.aborted
              ? uiText('common:text_7a7f8cdf2117')
              : error instanceof Error
                ? error.message
                : uiText('common:text_5e52edd7bbc2'),
          );
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      alive = false;
      abort.abort();
      clearTimeout(timeout);
    };
  }, [options.scope, statusAttempt]);
  useEffect(() => {
    const cancel = () => {
      controller.cancel();
      latest.current.onInvalidate?.();
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('pagehide', cancel);
    window.addEventListener('openbot:account-expired', cancel);
    window.addEventListener('openbot:unpaired', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', cancel);
      window.removeEventListener('openbot:account-expired', cancel);
      window.removeEventListener('openbot:unpaired', cancel);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [controller]);
  return {
    state,
    get busy() {
      return controller.busy;
    },
    start(capture: DictationCapture) {
      const error =
        audioSupportError() ||
        statusError ||
        (!status
          ? uiText('common:text_e72808bc0745')
          : !status.available
            ? status.reason || uiText('common:text_085f7aa095cb')
            : '');
      if (error) {
        controller.error(error);
        return;
      }
      if (!latest.current.enabled || document.hidden) return;
      void controller.start(capture);
    },
    finish: () => void controller.finish(),
    cancel: () => {
      controller.cancel(uiText('common:text_936663463bd8'));
      latest.current.onInvalidate?.();
    },
    dismiss: () => {
      controller.cancel();
      latest.current.onInvalidate?.();
    },
    retryStatus: () => {
      if (controller.busy) return;
      controller.error(uiText('common:text_3e0779cac96f'));
      setStatusAttempt((value) => value + 1);
    },
  };
}

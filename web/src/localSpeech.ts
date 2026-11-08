export type LocalVoice = Pick<SpeechSynthesisVoice, 'voiceURI' | 'name' | 'lang'>;
export type SpeechFailure = 'unsupported' | 'no_local_voice' | 'voice_missing' | 'failed';
export type LocalSpeechState = {
  voices: LocalVoice[];
  supported: boolean;
  speakingId?: string;
  error?: SpeechFailure;
};
const owners = new WeakMap<SpeechSynthesis, () => void>();
export function speechChunks(text: string): string[] {
  const characters = Array.from(text.trim()),
    chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += 400)
    chunks.push(characters.slice(offset, offset + 400).join(''));
  return chunks;
}
export function createLocalSpeech(options: {
  synthesis?: SpeechSynthesis;
  utterance?: (text: string) => SpeechSynthesisUtterance;
  current: () => boolean;
  onChange: (state: LocalSpeechState) => void;
}) {
  const synthesis = options.synthesis;
  let active = false,
    generation = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  let currentVoiceURI: string | undefined;
  let currentUtterance: SpeechSynthesisUtterance | undefined;
  let state: LocalSpeechState = { voices: [], supported: !!synthesis && !!options.utterance };
  const publish = (value: Partial<LocalSpeechState>) => {
    state = { ...state, ...value };
    options.onChange(state);
  };
  const current = () => active && options.current();
  function stop() {
    generation++;
    currentVoiceURI = undefined;
    currentUtterance = undefined;
    clearTimeout(timer);
    if (synthesis && owners.get(synthesis) === stop) {
      owners.delete(synthesis);
      try {
        synthesis.cancel();
      } catch {
        /* Cancellation must still invalidate callbacks. */
      }
    }
    publish({ speakingId: undefined });
  }
  function voices() {
    try {
      return synthesis?.getVoices().filter((voice) => voice.localService === true) || [];
    } catch {
      return [];
    }
  }
  function refresh() {
    if (!active) return;
    const available = voices();
    publish({ voices: available.map(({ voiceURI, name, lang }) => ({ voiceURI, name, lang })) });
    if (state.speakingId && !available.some((voice) => voice.voiceURI === currentVoiceURI))
      fail('voice_missing');
  }
  function fail(error: SpeechFailure) {
    stop();
    publish({ error });
  }
  return {
    getSnapshot: () => state,
    stop,
    refresh,
    speak(input: { id: string; text: string; voiceURI: string; rate: number; language: string }) {
      if (!current()) return false;
      stop();
      if (!state.supported || !synthesis || !options.utterance) {
        fail('unsupported');
        return false;
      }
      const available = voices();
      if (!available.length) {
        fail('no_local_voice');
        return false;
      }
      const voice = input.voiceURI
        ? available.find((item) => item.voiceURI === input.voiceURI)
        : available.find((item) =>
            item.lang.toLowerCase().startsWith(input.language.toLowerCase().split('-')[0]),
          ) || available[0];
      if (!voice) {
        fail('voice_missing');
        return false;
      }
      const chunks = speechChunks(input.text);
      if (!chunks.length || !Number.isFinite(input.rate) || input.rate < 0.5 || input.rate > 2)
        return false;
      owners.get(synthesis)?.();
      owners.set(synthesis, stop);
      currentVoiceURI = voice.voiceURI;
      const version = ++generation;
      const valid = () => current() && version === generation && owners.get(synthesis) === stop;
      function next() {
        if (!valid()) {
          if (version === generation) stop();
          return;
        }
        if (
          !voices().some((item) => item.localService === true && item.voiceURI === voice!.voiceURI)
        ) {
          fail('voice_missing');
          return;
        }
        const text = chunks.shift();
        if (text === undefined) {
          stop();
          return;
        }
        let utterance: SpeechSynthesisUtterance;
        try {
          utterance = options.utterance!(text);
        } catch {
          fail('failed');
          return;
        }
        utterance.voice = voice!;
        utterance.lang = voice!.lang;
        utterance.rate = input.rate;
        currentUtterance = utterance;
        utterance.onend = () => {
          if (version !== generation || currentUtterance !== utterance) return;
          clearTimeout(timer);
          if (valid()) next();
          else stop();
        };
        utterance.onerror = () => {
          if (version === generation) {
            if (valid()) fail('failed');
            else stop();
          }
        };
        timer = setTimeout(() => {
          if (version === generation) {
            if (valid()) fail('failed');
            else stop();
          }
        }, 120000);
        try {
          synthesis!.speak(utterance);
        } catch {
          if (valid()) fail('failed');
        }
      }
      publish({ speakingId: input.id, error: undefined });
      next();
      return state.speakingId === input.id;
    },
    resume() {
      active = true;
      synthesis?.addEventListener('voiceschanged', refresh);
      refresh();
    },
    suspend() {
      active = false;
      stop();
      synthesis?.removeEventListener('voiceschanged', refresh);
    },
  };
}

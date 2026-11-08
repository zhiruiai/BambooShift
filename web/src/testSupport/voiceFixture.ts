import type { Message } from '../../../shared/types';
import { createVoicePlayback, type VoiceContext } from '../voicePlayback';
import { createVoicePreferences } from '../voicePreferences';
import { storage, identity, snapshot, input, completed } from './notificationsFixture';
export { storage, identity, snapshot, input, completed };
export const localVoice = (language = 'en-US', localService = true): SpeechSynthesisVoice => ({
  voiceURI: `${localService ? 'local' : 'remote'}-${language}`,
  name: `Synthetic ${language}`,
  lang: language,
  localService,
  default: false,
});
export class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = '';
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}
export function fakeSpeech() {
  const events = new EventTarget(),
    spoken: FakeUtterance[] = [];
  let cancels = 0,
    voices = [localVoice('en-US'), localVoice('zh-CN'), localVoice('en-GB', false)];
  const synthesis = Object.assign(events, {
    getVoices: () => voices,
    speak: (utterance: FakeUtterance) => {
      spoken.push(utterance);
    },
    cancel: () => {
      cancels++;
    },
  });
  return {
    synthesis: synthesis as unknown as SpeechSynthesis,
    utterance: (text: string) => new FakeUtterance(text) as unknown as SpeechSynthesisUtterance,
    spoken,
    get cancels() {
      return cancels;
    },
    setVoices(value: SpeechSynthesisVoice[]) {
      voices = value;
      events.dispatchEvent(new Event('voiceschanged'));
    },
  };
}
export function voiceFixture() {
  const saved = storage(),
    speech = fakeSpeech();
  let current = true;
  let context: VoiceContext = {
    conversationId: 'chat-a',
    agentId: 'bot-a',
    enabled: true,
    blocked: false,
  };
  const preferences = createVoicePreferences({ identity, storage: saved });
  const playback = createVoicePlayback({
    identity,
    preferences,
    context: () => context,
    current: () => current,
    ...speech,
  });
  playback.resume();
  playback.baseline(snapshot([input()]));
  return {
    saved,
    preferences,
    playback,
    speech,
    setCurrent(value: boolean) {
      current = value;
    },
    setContext(value: Partial<VoiceContext>) {
      context = { ...context, ...value };
    },
    read(text: string) {
      return playback.read({ ...completed(), content: text } as Message);
    },
    dispose: () => playback.suspend(),
  };
}

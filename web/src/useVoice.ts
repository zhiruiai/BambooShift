import { useEffect, useRef, useState } from 'react';
import { createPrimaryBotScope } from './primaryBot';
import { createVoicePreferences, type VoiceIdentity } from './voicePreferences';
import { createVoicePlayback, voiceContextKey, type VoiceContext } from './voicePlayback';

export function useWorkspaceVoice(props: VoiceIdentity & VoiceContext) {
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const [scope] = useState(() =>
    createPrimaryBotScope({ ...props, identity: () => latest.current }),
  );
  const [playback] = useState(() => {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      /* In-memory preferences remain available. */
    }
    return createVoicePlayback({
      identity: props,
      preferences: createVoicePreferences({ identity: props, storage, events: window }),
      context: () => ({ ...latest.current, enabled: latest.current.enabled && !document.hidden }),
      current: () => mounted.current && scope.current(scope.ticket()),
      synthesis: typeof window.speechSynthesis === 'object' ? window.speechSynthesis : undefined,
      utterance:
        typeof window.SpeechSynthesisUtterance === 'function'
          ? (text) => new window.SpeechSynthesisUtterance(text)
          : undefined,
    });
  });
  const [state, setState] = useState(playback.getSnapshot);
  const context = voiceContextKey(props);
  useEffect(() => {
    mounted.current = true;
    scope.resume();
    playback.resume();
    const release = playback.subscribe(() => setState(playback.getSnapshot()));
    setState(playback.getSnapshot());
    const invalidate = () => {
      playback.suspend();
      scope.suspend();
    };
    const hidden = () => {
      if (document.hidden) playback.stop();
    };
    const events = [
      'pagehide',
      'openbot:account-expired',
      'openbot:unpaired',
      'openbot:revalidate',
    ];
    events.forEach((event) => window.addEventListener?.(event, invalidate));
    document.addEventListener?.('visibilitychange', hidden);
    return () => {
      mounted.current = false;
      release();
      playback.suspend();
      scope.suspend();
      events.forEach((event) => window.removeEventListener?.(event, invalidate));
      document.removeEventListener?.('visibilitychange', hidden);
    };
  }, [playback, scope, props.userId, props.workspaceId]);
  useEffect(() => {
    playback.stop();
  }, [playback, context, props.enabled]);
  useEffect(() => {
    if (props.blocked) playback.stopReading();
  }, [playback, props.blocked]);
  const current = () =>
    mounted.current && scope.current(scope.ticket()) && voiceContextKey(latest.current) === context;
  return {
    ...playback,
    state,
    blocked: props.blocked,
    baseline: (data: Parameters<typeof playback.baseline>[0]) => {
      if (!mounted.current) return;
      scope.resume();
      if (current()) {
        playback.resume();
        playback.baseline(data);
      }
    },
    read: (message: Parameters<typeof playback.read>[0]) => current() && playback.read(message),
    arm: () => {
      if (current()) playback.arm();
    },
    update: (value: Parameters<typeof playback.update>[0]) => {
      if (current()) playback.update(value);
    },
    refresh: () => {
      if (current()) playback.refresh();
    },
  };
}
export type WorkspaceVoice = ReturnType<typeof useWorkspaceVoice>;

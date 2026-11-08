import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../shared/types';
import { createLocalSpeech } from './localSpeech';
import { audioSupportError } from './speechAudio';
import { speechStatus, transcribeSpeech } from './speech';
import { currentWorkspaceId } from './workspace-scope';
import { createVoiceCallController, idleVoiceCall } from './voiceCall';
import { openCallCapture } from './voiceCallCapture';
import { createVoiceCallTransport, voiceTranscript, type CallTarget } from './voiceCallTransport';
import type { WorkspaceModel } from './workspace/types';

function readCallReply(
  message: Message,
  signal: AbortSignal,
  voice: { voiceURI: string; rate: number },
) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    let started = false,
      settled = false;
    const speech = createLocalSpeech({
      synthesis: window.speechSynthesis,
      utterance:
        typeof SpeechSynthesisUtterance === 'function'
          ? (text) => new SpeechSynthesisUtterance(text)
          : undefined,
      current: () => !signal.aborted && !document.hidden,
      onChange: (state) => {
        if (started && !state.speakingId)
          queueMicrotask(() => finish(!speech.getSnapshot().error && !signal.aborted));
      },
    });
    function finish(value: boolean) {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      speech.suspend();
      resolve(value);
    }
    const cancel = () => finish(false);
    signal.addEventListener('abort', cancel, { once: true });
    speech.resume();
    const text =
      message.content
        .replace(/```[\s\S]*?```/g, '')
        .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
        .trim() || message.content;
    if (
      !speech.speak({
        id: message.id,
        text,
        ...voice,
        language: /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en',
      })
    ) {
      finish(false);
      return;
    }
    started = true;
  });
}

const emptyMessages: Message[] = [];

export function useVoiceCall(model: WorkspaceModel) {
  const conversation = model.conversation;
  const workspaceId = model.account?.workspace.id;
  const userId = model.currentUserId;
  const agentId = conversation?.agentIds[0];
  const chat = conversation?.id;
  const isDirect =
    !!conversation &&
    !conversation.isGroup &&
    !conversation.demo &&
    conversation.agentIds.length === 1;
  const viewAllowed =
    isDirect &&
    !model.sharedUnavailable &&
    !model.threadRootId &&
    (!model.mobileHome || model.mobileChat);
  const target: CallTarget | undefined =
    workspaceId && userId && chat && agentId && viewAllowed
      ? { workspaceId, userId, conversationId: chat, agentId }
      : undefined;
  const key = target ? `${workspaceId}:${userId}:${chat}:${agentId}` : '';
  const latest = useRef({ model, target });
  latest.current = { model, target };
  const mounted = useRef(true);
  const [state, setState] = useState(idleVoiceCall);
  const [speechReady, setSpeechReady] = useState(false);
  const [controller] = useState(() =>
    createVoiceCallController({
      target: () =>
        mounted.current && currentWorkspaceId() === latest.current.target?.workspaceId
          ? latest.current.target
          : undefined,
      capture: openCallCapture,
      transcribe: transcribeSpeech,
      speak: (reply, signal) => readCallReply(reply, signal, latest.current.model.voice.state),
      refresh: () => {
        void latest.current.model.refresh().catch(() => {});
      },
      onState: (next) => {
        if (mounted.current) setState(next);
      },
    }),
  );
  const messages = model.data?.messages || emptyMessages;
  useEffect(() => {
    mounted.current = true;
    const end = () => {
      void controller.end();
    };
    const hidden = () => {
      if (document.hidden) end();
    };
    const events = [
      'pagehide',
      'offline',
      'openbot:account-expired',
      'openbot:unpaired',
      'openbot:revalidate',
    ];
    events.forEach((event) => window.addEventListener(event, end));
    document.addEventListener('visibilitychange', hidden);
    return () => {
      mounted.current = false;
      end();
      events.forEach((event) => window.removeEventListener(event, end));
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [controller]);
  useEffect(() => {
    void controller.end();
  }, [controller, key]);
  useEffect(() => {
    const abort = new AbortController();
    setSpeechReady(false);
    if (workspaceId && userId && currentWorkspaceId() === workspaceId && !audioSupportError()) {
      const timer = setTimeout(() => abort.abort(), 10_000);
      void speechStatus(abort.signal)
        .then((value) => {
          if (!abort.signal.aborted) setSpeechReady(value.available);
        })
        .catch(() => {})
        .finally(() => clearTimeout(timer));
    }
    return () => abort.abort();
  }, [workspaceId, userId]);
  useEffect(() => {
    controller.receive(messages);
  }, [controller, messages, state]);

  const visible =
    !!target &&
    !model.draft.trim() &&
    !model.attachments.length &&
    !model.replyTo &&
    !model.currentComposer.appContext;
  const canStart =
    visible &&
    speechReady &&
    model.voice.state.supported &&
    model.voice.state.voices.length > 0 &&
    !model.modal &&
    !model.dictation.busy &&
    !model.working &&
    !model.sending.has(model.selected) &&
    !model.uploading.has(model.selected);
  return {
    state,
    active: state.phase !== 'idle',
    visible,
    canStart,
    turns: state.call ? voiceTranscript(messages, state.call) : emptyMessages,
    start() {
      if (!target || !canStart || document.hidden || currentWorkspaceId() !== target.workspaceId)
        return;
      model.voice.stop();
      void controller.start(target, createVoiceCallTransport(model.api, target));
    },
    end: () => {
      void controller.end();
    },
    mute: controller.mute,
    resume: controller.resume,
  };
}

export type WorkspaceVoiceCall = ReturnType<typeof useVoiceCall>;

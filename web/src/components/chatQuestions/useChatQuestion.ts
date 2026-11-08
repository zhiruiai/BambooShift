import { useEffect, useRef, useState } from 'react';
import {
  normalizeChatQuestionSelection,
  parseChatQuestion,
  type ChatQuestion,
} from '../../../../shared/chat-questions';
import type { Message } from '../../../../shared/types';
import { ApiError } from '../../api';
import type { FixedWorkspaceApi } from '../../fixedWorkspaceApi';

export type ChatQuestionProps = {
  message: Message;
  question: ChatQuestion;
  userId?: string;
  localTargetAvailable: boolean;
  current: () => boolean;
  request: FixedWorkspaceApi;
  onConfirmed: () => void;
};

type Phase = 'ready' | 'sending' | 'checking' | 'unknown' | 'retry' | 'unavailable';
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const questionIdentity = ({ version, question, mode, options, requester, runId }: ChatQuestion) =>
  JSON.stringify([version, question, mode, options, requester, runId]);

function matchingQuestion(value: unknown, { message, question }: ChatQuestionProps) {
  const row = object(value);
  if (
    row?.id !== message.id ||
    row.conversationId !== message.conversationId ||
    row.agentId !== message.agentId ||
    row.threadRootId !== message.threadRootId ||
    row.role !== 'assistant' ||
    row.kind !== 'question' ||
    row.status !== 'done'
  )
    return;
  const observed = parseChatQuestion(object(row.metadata)?.question);
  return observed && questionIdentity(observed) === questionIdentity(question)
    ? observed
    : undefined;
}

function acceptedQuestion(value: unknown, props: ChatQuestionProps, optionIds: string[]) {
  const receipt = object(value);
  const answer = matchingQuestion(receipt?.question, props);
  const message = object(receipt?.message);
  const delivery = object(message?.delivery);
  const marker = object(object(message?.metadata)?.questionAnswer);
  const sameOptions = (selected: unknown) =>
    Array.isArray(selected) &&
    selected.length === optionIds.length &&
    optionIds.every((id, index) => selected[index] === id);
  if (
    answer?.status !== 'answered' ||
    !sameOptions(answer.answer.optionIds) ||
    message?.id !== answer.answer.messageId ||
    message.role !== 'user' ||
    message.userId !== props.question.requester.userId ||
    message.conversationId !== props.message.conversationId ||
    message.threadRootId !== props.message.threadRootId ||
    object(message.replyTo)?.id !== props.message.id ||
    delivery?.agentId !== props.message.agentId ||
    delivery?.mode !== 'followUp' ||
    marker?.questionId !== props.message.id ||
    !sameOptions(marker.optionIds)
  )
    return;
  return answer;
}

export function useChatQuestion(props: ChatQuestionProps) {
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('ready');
  const [failed, setFailed] = useState(false);
  const [confirmed, setConfirmed] = useState<ChatQuestion>();
  const question =
    props.question.status === 'answered' ? props.question : (confirmed ?? props.question);
  const selected = question.status === 'answered' ? question.answer.optionIds : picked;
  const requester = props.userId === question.requester.userId;
  const allowed = requester && props.localTargetAvailable && question.status === 'pending';
  const busy = phase === 'sending' || phase === 'checking';
  const selectEnabled = allowed && phase === 'ready';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function select(id: string) {
    if (!selectEnabled || inFlight.current || !latest.current.current()) return;
    setFailed(false);
    setPicked((old) =>
      question.mode === 'single'
        ? [id]
        : old.includes(id)
          ? old.filter((item) => item !== id)
          : [...old, id],
    );
  }

  async function respond(check = false) {
    const original = latest.current;
    const optionIds = normalizeChatQuestionSelection(question, selected);
    if (!allowed || !original.current() || inFlight.current || !optionIds) return;
    if (check ? phase !== 'unknown' : phase !== 'ready' && phase !== 'retry') return;
    inFlight.current = true;
    setFailed(false);
    setPhase(check ? 'checking' : 'sending');
    try {
      if (check) {
        const snapshot = await original.request<{ messages?: unknown }>('/bootstrap');
        if (!mounted.current) return;
        if (!Array.isArray(snapshot?.messages)) {
          setPhase('unknown');
          return;
        }
        const observed = matchingQuestion(
          snapshot.messages.find((item) => object(item)?.id === original.message.id),
          original,
        );
        if (observed?.status === 'answered') {
          setConfirmed(observed);
          latest.current.onConfirmed();
        } else {
          setPhase(observed ? 'retry' : 'unavailable');
          return;
        }
      } else {
        const result = await original.request<unknown>(
          `/messages/${encodeURIComponent(original.message.id)}/answer`,
          'POST',
          { optionIds },
        );
        if (!mounted.current) return;
        const receipt = acceptedQuestion(result, original, optionIds);
        if (!receipt) {
          setPhase('unknown');
          return;
        }
        setConfirmed(receipt);
        latest.current.onConfirmed();
      }
      setPhase('ready');
    } catch (error) {
      if (!mounted.current) return;
      if (
        error instanceof ApiError &&
        (error.code === 'QUESTION_UNAVAILABLE' ||
          error.code === 'THREAD_CONTEXT_UNAVAILABLE' ||
          error.code === 'QUESTION_FORBIDDEN' ||
          [401, 403, 404].includes(error.status))
      ) {
        setPhase('unavailable');
      } else if (
        !check &&
        error instanceof ApiError &&
        (error.code === 'QUESTION_INVALID' ||
          error.code === 'QUESTION_LIMIT' ||
          error.status === 429)
      ) {
        setPhase(phase === 'retry' ? 'retry' : 'ready');
        setFailed(true);
      } else {
        setPhase('unknown');
      }
    } finally {
      inFlight.current = false;
    }
  }

  return {
    question,
    selected,
    requester,
    allowed,
    busy,
    phase,
    failed,
    selectEnabled,
    select,
    respond,
  };
}

export interface ChatQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ChatQuestionAnswer {
  optionIds: string[];
  messageId: string;
  submittedAt: string;
}

interface QuestionContent {
  version: 1;
  question: string;
  mode: 'single' | 'multiple';
  options: ChatQuestionOption[];
  requester: { userId: string; messageId: string };
  runId: string;
}

export type ChatQuestion = QuestionContent &
  ({ status: 'pending'; answer?: never } | { status: 'answered'; answer: ChatQuestionAnswer });

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key));
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value: unknown, limit: number, allowEmpty = false): value is string =>
  typeof value === 'string' &&
  (allowEmpty || !!value.trim()) &&
  value.length <= limit &&
  !/\p{Cc}/u.test(value);

function parseOption(value: unknown): ChatQuestionOption | undefined {
  if (
    !record(value) ||
    !only(value, ['id', 'label', 'description']) ||
    !id(value.id) ||
    value.id.length > 32 ||
    !text(value.label, 160) ||
    (value.description !== undefined && !text(value.description, 300, true))
  )
    return;
  return { id: value.id, label: value.label, description: value.description };
}

export function normalizeChatQuestionSelection(
  question: Pick<QuestionContent, 'mode' | 'options'>,
  values: unknown,
): string[] | undefined {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > question.options.length ||
    (question.mode === 'single' && values.length !== 1)
  )
    return;
  const selected = new Set(values);
  if (selected.size !== values.length) return;
  const ordered = question.options
    .filter((option) => selected.has(option.id))
    .map((option) => option.id);
  return ordered.length === values.length ? ordered : undefined;
}

export function parseChatQuestion(value: unknown): ChatQuestion | undefined {
  if (
    !record(value) ||
    !only(value, [
      'version',
      'question',
      'mode',
      'options',
      'requester',
      'runId',
      'status',
      'answer',
    ]) ||
    value.version !== 1 ||
    !text(value.question, 500) ||
    (value.mode !== 'single' && value.mode !== 'multiple') ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 6 ||
    !id(value.runId) ||
    !record(value.requester) ||
    !only(value.requester, ['userId', 'messageId']) ||
    !id(value.requester.userId) ||
    !id(value.requester.messageId)
  )
    return;
  const options: ChatQuestionOption[] = [];
  for (const raw of value.options) {
    const option = parseOption(raw);
    if (!option || options.some((prior) => prior.id === option.id)) return;
    options.push(option);
  }
  const question: QuestionContent = {
    version: 1,
    question: value.question,
    mode: value.mode,
    options,
    runId: value.runId,
    requester: { userId: value.requester.userId, messageId: value.requester.messageId },
  };
  if (value.status === 'pending' && value.answer === undefined)
    return { ...question, status: 'pending' };
  const answer = value.answer;
  if (
    value.status !== 'answered' ||
    !record(answer) ||
    !only(answer, ['optionIds', 'messageId', 'submittedAt']) ||
    !id(answer.messageId) ||
    typeof answer.submittedAt !== 'string' ||
    answer.submittedAt.length > 40 ||
    !Number.isFinite(Date.parse(answer.submittedAt))
  )
    return;
  const optionIds = normalizeChatQuestionSelection(question, answer.optionIds);
  if (!optionIds) return;
  return {
    ...question,
    status: 'answered',
    answer: { optionIds, messageId: answer.messageId, submittedAt: answer.submittedAt },
  };
}

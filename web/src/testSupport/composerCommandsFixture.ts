import type { ComposerState } from '../chatDrafts';
import type { BotAgent, Skill } from '../../../shared/types';
import type { ConnectedApp } from '../../../shared/app-connections';
import { createChatSendScope } from '../chatSendScope';
import { all, harness, text } from './creationFlowFixture';

export const bot: BotAgent = {
  id: 'bot-a',
  name: 'Aster',
  role: 'Writer',
  description: '',
  instructions: '',
  avatar: 'orb',
  color: '#725793',
  status: 'idle',
};
export const peer: BotAgent = { ...bot, id: 'bot-b', name: 'Birch' };
export const skill: Skill = {
  id: 'skill-a',
  agentId: bot.id,
  name: 'Summarize',
  description: 'Summarize a document',
  content: 'SYNTHETIC_SKILL_BODY',
  version: 1,
  status: 'active',
  createdAt: '2026-11-06T00:00:00.000Z',
};

export async function composerFixture(
  options: {
    draft?: string;
    member?: boolean;
    skills?: Skill[];
    apps?: ConnectedApp[];
    language?: 'en' | 'zh-CN';
  } = {},
) {
  const frames: Array<() => void> = [],
    timers: Array<() => void> = [];
  const calls: string[] = [];
  const document = Object.assign(new EventTarget(), { hidden: false, getElementById: () => null });
  const inside = {};
  const field = {
    value: options.draft ?? '/',
    selectionStart: 1,
    selectionEnd: 1,
    readOnly: false,
    disabled: false,
    focus() {
      calls.push('focus');
    },
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    closest: () => ({ contains: (target: unknown) => target === field || target === inside }),
  };
  field.selectionStart = field.selectionEnd = field.value.length;
  let identity = { userId: 'synthetic-member', workspaceId: 'synthetic-space' };
  const scope = createChatSendScope({
    ...identity,
    identity: () => identity,
    locationWorkspace: () => identity.workspaceId,
  });
  scope.resume();
  const attachment = {
    id: 'existing-file',
    name: 'kept.txt',
    type: 'text/plain',
    size: 3,
    createdAt: skill.createdAt,
  };
  const composer: ComposerState = {
    text: field.value,
    attachments: [attachment],
    mode: 'followUp',
    replyTo: { id: 'quoted', author: 'Aster', content: 'Keep the quote', kind: 'text' },
  };
  let ui: Awaited<ReturnType<typeof harness>>;
  const props = {
    selected: 'chat-a',
    navigationScope: 'synthetic-member:synthetic-space',
    modal: null as string | null,
    draft: composer.text,
    currentComposer: composer,
    members: [bot, peer],
    skills: options.skills ?? [skill],
    data: { apps: options.apps ?? [] },
    canManage: !options.member,
    sharedUnavailable: false,
    sendScope: scope,
    composerRef: { current: field },
    appearance: { spellCheck: true },
    compositionRef: { current: false },
    pendingDictation: { current: null },
    conversation: { id: 'chat-a', title: 'Synthetic conversation' },
    updateComposer(id: string, update: (value: ComposerState) => ComposerState) {
      if (id !== props.selected) throw Error('A stale conversation was changed.');
      props.currentComposer = update(props.currentComposer);
      props.draft = props.currentComposer.text;
      ui.setProps({ currentComposer: props.currentComposer, draft: props.draft });
    },
    setDraft(value: string) {
      props.updateComposer(props.selected, (old) => ({ ...old, text: value }));
    },
    rememberSelection() {
      calls.push('selection');
    },
    insertDictation() {
      calls.push('dictation-insert');
    },
    pasteFiles() {
      calls.push('paste');
    },
    toggleDictation() {
      calls.push('dictation-toggle');
    },
    send() {
      calls.push('send');
    },
    openSettings(view: string) {
      calls.push(`settings:${view}`);
    },
    openApps() {
      props.setModal('apps');
    },
    openComputer() {
      calls.push('computer');
    },
    setRoutineToEdit(value: string | null) {
      calls.push(`routine:${value}`);
    },
    setModal(value: string | null) {
      calls.push(`modal:${value}`);
      props.modal = value;
      ui.setProps({ modal: value });
    },
  };
  ui = await harness(
    'web/src/workspace/ComposerInput.tsx',
    'ComposerInput',
    props,
    {
      document,
      window: {
        localStorage: {
          getItem: () => JSON.stringify({ version: 1, locale: options.language ?? 'zh-CN' }),
        },
      },
      requestAnimationFrame(callback: () => void) {
        frames.push(callback);
        return frames.length;
      },
      setTimeout(callback: () => void) {
        timers.push(callback);
        return timers.length;
      },
    },
    (tree) => {
      field.value = all(tree, (node) => node.type === 'textarea')[0].props.value;
    },
  );
  const input = () => all(ui.tree, (node) => node.type === 'textarea')[0];
  const flush = async () => {
    await ui.flush();
    for (const callback of frames.splice(0)) callback();
    await ui.flush();
  };
  await flush();
  return {
    ui,
    props,
    field,
    calls,
    document,
    scope,
    input,
    flush,
    options: () => all(ui.tree, (node) => node.props?.role === 'option'),
    option: (label: string) =>
      all(ui.tree, (node) => node.props?.role === 'option' && text(node).includes(label))[0],
    async focus() {
      input().props.onFocus();
      await flush();
    },
    async select(start: number, end = start) {
      field.setSelectionRange(start, end);
      input().props.onSelect({ currentTarget: field });
      await flush();
    },
    async type(value: string, caret = value.length) {
      field.value = value;
      field.setSelectionRange(caret, caret);
      input().props.onChange({ target: field, currentTarget: field });
      await flush();
    },
    async key(key: string, extras: Record<string, unknown> = {}) {
      let prevented = false,
        stopped = false;
      input().props.onKeyDown({
        key,
        shiftKey: false,
        repeat: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        nativeEvent: { isComposing: false, keyCode: 0 },
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {
          stopped = true;
        },
        ...extras,
      });
      await flush();
      return { prevented, stopped };
    },
    async timers() {
      for (const callback of timers.splice(0)) callback();
      await flush();
    },
    async change(update: Record<string, unknown>) {
      Object.assign(props, update);
      ui.setProps(update);
      await flush();
    },
    switchIdentity() {
      identity = { ...identity, userId: 'different-member' };
    },
    dispose() {
      ui.dispose();
      scope.suspend();
    },
  };
}

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BotAgent } from '../../../shared/types';
import type { ConnectedApp } from '../../../shared/app-connections';
import { isSharedBot } from '../../../shared/shared-bots';
import { MAX_GROUP_MENTIONS } from '../../../shared/chat-mentions';
import {
  groupMentionsUnavailable,
  mentionBotAvailable,
  selectBotMention,
} from '../composerMentions';
import { uiText } from '../i18n';
import type { WorkspaceModel } from './types';
import {
  commandToken,
  composerCommands,
  matchingCommands,
  mentionToken,
  replaceCommand,
  type ComposerCommand,
} from './composerCommands';

export type CommandProps = Pick<
  WorkspaceModel,
  | 'selected'
  | 'conversation'
  | 'draft'
  | 'members'
  | 'skills'
  | 'data'
  | 'canManage'
  | 'currentComposer'
  | 'composerRef'
  | 'updateComposer'
  | 'rememberSelection'
  | 'navigationScope'
  | 'sendScope'
  | 'modal'
  | 'openSettings'
  | 'openApps'
  | 'openComputer'
  | 'setRoutineToEdit'
  | 'setModal'
  | 'sharedUnavailable'
> & { composerKey?: string; threadRootId?: string };

type Mention = { id: string; kind: 'mention'; agent: BotAgent };
type AppMention = { id: string; kind: 'appMention'; app: ConnectedApp };
type EveryoneMention = { id: 'group-everyone'; kind: 'everyoneMention' };
type Choice = ComposerCommand | Mention | AppMention | EveryoneMention;

export function useComposerCommands(props: CommandProps) {
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [index, setIndex] = useState(0);
  const composerKey = props.composerKey ?? props.selected;
  const scope = `${props.navigationScope}:${composerKey}`;
  const ticket = props.sendScope.ticket();
  const command = commandToken(props.draft, selection.start, selection.end);
  const mention = command ? undefined : mentionToken(props.draft, selection.start, selection.end);
  const token = command || mention;
  const group = props.conversation?.isGroup === true;
  const audience = props.currentComposer.mentions;
  const everyone = audience && 'everyone' in audience;
  const selectedIds = audience && 'agentIds' in audience ? audience.agentIds : [];
  const key = `${scope}:${token?.start}:${token?.end}:${token?.value}:${props.draft}`;
  const commands = command
    ? matchingCommands(
        composerCommands({
          skills: props.skills,
          members: props.members,
          canManage: props.canManage,
          agentId: props.currentComposer.agentId,
          skillsEnabled:
            !props.sharedUnavailable && !audience && !props.currentComposer.requestVoiceMemo,
        }),
        command.query,
      )
    : [];
  const mentions: Array<Mention | AppMention | EveryoneMention> =
    mention && !props.sharedUnavailable && !everyone
      ? props.members
          .filter(
            (agent) =>
              mentionBotAvailable(agent) &&
              (!props.currentComposer.skillId || props.currentComposer.agentId === agent.id) &&
              (selectedIds.length < MAX_GROUP_MENTIONS || selectedIds.includes(agent.id)) &&
              agent.name.toLocaleLowerCase().includes(mention.query.toLocaleLowerCase()),
          )
          .map((agent) => ({ id: agent.id, kind: 'mention', agent }))
      : [];
  if (
    mention &&
    group &&
    !everyone &&
    !props.currentComposer.appContext &&
    !props.currentComposer.skillId &&
    !props.sharedUnavailable &&
    !groupMentionsUnavailable({ everyone: true }, group, props.members) &&
    ['everyone', uiText('workspace:composerEveryone')].some((name) =>
      name.toLocaleLowerCase().includes(mention.query.toLocaleLowerCase()),
    )
  )
    mentions.push({ id: 'group-everyone', kind: 'everyoneMention' });
  if (
    mention &&
    !audience &&
    props.members.length > 0 &&
    props.members.every((agent) => !isSharedBot(agent))
  ) {
    mentions.push(
      ...(props.data?.apps || [])
        .filter(
          (app) =>
            app.status === 'connected' &&
            app.toolCount > 0 &&
            app.name.toLocaleLowerCase().includes(mention.query.toLocaleLowerCase()),
        )
        .map((app): AppMention => ({ id: `app-${app.id}`, kind: 'appMention', app })),
    );
  }
  const items: Choice[] = command ? commands : mentions;
  const open =
    focused &&
    !composing &&
    !props.modal &&
    (!!command || mentions.length > 0) &&
    dismissed !== key &&
    !props.composerRef.current?.readOnly &&
    !props.composerRef.current?.disabled &&
    props.sendScope.current(ticket);
  const active = items[Math.min(index, items.length - 1)];
  const latest = useRef({ props, scope, key, token, items, open });
  latest.current = { props, scope, key, token, items, open };
  const consumed = useRef('');

  useEffect(() => {
    setIndex(0);
    setDismissed('');
    consumed.current = '';
  }, [key]);
  useEffect(() => {
    setFocused(false);
    setComposing(false);
    setDismissed('');
  }, [scope]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!props.composerRef.current?.closest('.composer')?.contains(event.target as Node)) {
        setFocused(false);
        setDismissed(key);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, key, props.composerRef]);

  function readSelection(field = props.composerRef.current) {
    if (!field) return;
    setSelection({ start: field.selectionStart, end: field.selectionEnd });
    props.rememberSelection();
  }
  function choose(choice: Choice) {
    const current = latest.current;
    if (
      !open ||
      !current.open ||
      current.key !== key ||
      current.scope !== scope ||
      consumed.current === key ||
      !props.sendScope.current(ticket) ||
      !token
    )
      return;
    const field = props.composerRef.current;
    if (
      !field ||
      field.readOnly ||
      field.disabled ||
      field.value !== props.draft ||
      field.selectionStart !== selection.start ||
      field.selectionEnd !== selection.end
    )
      return;
    const selected = current.items.find(
      (item) => item.id === choice.id && item.kind === choice.kind,
    );
    if (!selected) return;
    if (
      choice.kind === 'appMention' &&
      selected.kind === 'appMention' &&
      choice.app.revision !== selected.app.revision
    )
      return;
    const following = props.draft[token.end];
    const insertion =
      selected.kind === 'skill'
        ? selected.skillId
          ? ''
          : uiText('workspace:composerSkillDraft', { name: selected.skillName })
        : selected.kind === 'mention'
          ? `@${selected.agent.name}${following ? '' : ' '}`
          : selected.kind === 'everyoneMention'
            ? `@everyone${following ? '' : ' '}`
            : '';
    const next = replaceCommand(props.draft, token, insertion);
    if (!next) return;
    if ((selected.kind === 'mention' || selected.kind === 'everyoneMention') && following === ' ')
      next.caret++;
    consumed.current = key;
    setDismissed(key);
    props.updateComposer(composerKey, (previous) =>
      previous.text !== props.draft
        ? previous
        : {
            ...(selected.kind === 'mention'
              ? selectBotMention(previous, selected.agent.id, group)
              : previous),
            text: next.text,
            ...(selected.kind === 'skill'
              ? { agentId: selected.agentId, skillId: selected.skillId }
              : selected.kind === 'everyoneMention'
                ? { agentId: undefined, mentions: { everyone: true } as const }
                : selected.kind === 'appMention'
                  ? {
                      appContext: {
                        connectionId: selected.app.id,
                        revision: selected.app.revision,
                        name: selected.app.name,
                      },
                    }
                  : {}),
          },
    );
    if (selected.kind === 'settings') props.openSettings('general');
    else if (selected.kind === 'computer') props.openComputer();
    else if (selected.kind === 'apps') props.openApps();
    else if (selected.kind === 'routines') {
      props.setRoutineToEdit(null);
      props.setModal('routine');
    } else {
      // React commits the controlled draft before restoring the insertion caret.
      requestAnimationFrame(() => {
        if (
          latest.current.scope !== scope ||
          !props.sendScope.current(ticket) ||
          props.composerRef.current !== field ||
          field.readOnly ||
          field.disabled ||
          field.value !== next.text ||
          latest.current.props.modal
        )
          return;
        field.focus();
        field.setSelectionRange(next.caret, next.caret);
        readSelection(field);
      });
    }
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(key);
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length)
        setIndex(
          (old) => (old + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length,
        );
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat && active) choose(active);
      return true;
    }
    return false;
  }
  return {
    open: open && !!command,
    mentionOpen: open && !!mention,
    active,
    commands,
    mentions,
    index,
    setIndex,
    choose,
    keyDown,
    readSelection,
    focus() {
      consumed.current = '';
      setFocused(true);
      readSelection();
    },
    blur() {
      setFocused(false);
    },
    composition(value: boolean) {
      setComposing(value);
    },
  };
}

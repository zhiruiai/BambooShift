import { Clock3, Link2, Monitor, Settings, Sparkles, Users } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Avatar } from '../components/Avatar';
import { uiText } from '../i18n';
import type { WorkspaceModel } from './types';
import { useComposerCommands, type CommandProps } from './useComposerCommands';
import './composerCommands.css';

export type ComposerInputProps = CommandProps &
  Pick<
    WorkspaceModel,
    | 'appearance'
    | 'setDraft'
    | 'compositionRef'
    | 'pendingDictation'
    | 'insertDictation'
    | 'pasteFiles'
    | 'toggleDictation'
    | 'send'
    | 'conversation'
  >;

export function ComposerInput(props: ComposerInputProps) {
  const commands = useComposerCommands(props);
  const imeEnding = useRef(false);
  const { mentionOpen, active } = commands;
  const activeId = active
    ? active.kind === 'mention' || active.kind === 'appMention' || active.kind === 'everyoneMention'
      ? mentionOpen
        ? `mention-option-${active.id}`
        : undefined
      : commands.open
        ? `composer-command-${commands.commands.indexOf(active)}`
        : undefined
    : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);
  return (
    <>
      {commands.open && (
        <div className="mention-menu composer-command-menu">
          <span>
            {uiText('workspace:composerCommands')}
            <small>{uiText('workspace:composerCommandHint')}</small>
          </span>
          <div
            className="mention-options"
            role="listbox"
            id="composer-commands"
            aria-label={uiText('workspace:composerCommands')}
          >
            {commands.commands.map((item, index) => {
              const Icon = {
                skill: Sparkles,
                settings: Settings,
                computer: Monitor,
                routines: Clock3,
                apps: Link2,
              }[item.kind];
              return (
                <button
                  key={item.id}
                  id={`composer-command-${index}`}
                  type="button"
                  role="option"
                  aria-selected={commands.active?.id === item.id}
                  className={commands.active?.id === item.id ? 'active' : ''}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseEnter={() => commands.setIndex(index)}
                  onClick={() => commands.choose(item)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </span>
                </button>
              );
            })}
            {!commands.commands.length && (
              <p role="status">{uiText('workspace:composerNoCommands')}</p>
            )}
          </div>
        </div>
      )}
      {mentionOpen && (
        <div className="mention-menu">
          <span>
            {uiText('workspace:composerMentionTitle')}
            <small>{uiText('workspace:text_fd748c59afe2')}</small>
          </span>
          <div
            className="mention-options"
            role="listbox"
            id="composer-mentions"
            aria-label={uiText('workspace:composerMentionTitle')}
          >
            {commands.mentions.map((mention, index) => (
              <button
                key={mention.id}
                id={`mention-option-${mention.id}`}
                type="button"
                role="option"
                aria-selected={active?.id === mention.id}
                className={active?.id === mention.id ? 'active' : ''}
                onPointerDown={(event) => event.preventDefault()}
                onMouseEnter={() => commands.setIndex(index)}
                onClick={() => commands.choose(mention)}
              >
                {mention.kind === 'appMention' ? (
                  <>
                    <Link2 size={19} aria-hidden="true" />
                    <span>{mention.app.name}</span>
                    <small>{uiText('workspace:composerAppKind')}</small>
                  </>
                ) : mention.kind === 'everyoneMention' ? (
                  <>
                    <Users size={20} aria-hidden="true" />
                    <span>@everyone</span>
                    <small>{uiText('workspace:composerEveryone')}</small>
                  </>
                ) : (
                  <>
                    <Avatar agent={mention.agent} size={25} />
                    <span>{mention.agent.name}</span>
                    <small>{mention.agent.role}</small>
                  </>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <textarea
        ref={props.composerRef}
        data-thread-root-id={props.threadRootId}
        spellCheck={props.appearance.spellCheck}
        value={props.draft}
        onChange={(event) => {
          props.setDraft(event.target.value);
          commands.readSelection(event.currentTarget);
        }}
        onFocus={() => commands.focus()}
        onBlur={() => commands.blur()}
        onSelect={(event) => commands.readSelection(event.currentTarget)}
        onCompositionStart={() => {
          imeEnding.current = false;
          props.compositionRef.current = true;
          commands.composition(true);
        }}
        onCompositionEnd={() => {
          imeEnding.current = true;
          props.compositionRef.current = false;
          commands.composition(false);
          // Let the IME's final input/change event update the draft first.
          setTimeout(() => {
            imeEnding.current = false;
            if (props.compositionRef.current) return;
            commands.readSelection();
            const pending = props.pendingDictation.current;
            props.pendingDictation.current = null;
            if (pending) props.insertDictation(pending.capture, pending.text);
          }, 0);
        }}
        onPaste={props.pasteFiles}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={commands.open || mentionOpen}
        aria-controls={
          commands.open ? 'composer-commands' : mentionOpen ? 'composer-mentions' : undefined
        }
        aria-activedescendant={activeId}
        onKeyDown={(event) => {
          if (
            props.composerRef.current?.readOnly ||
            props.composerRef.current?.disabled ||
            props.compositionRef.current ||
            imeEnding.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          if (event.key === 'Enter' && event.repeat) {
            event.preventDefault();
            return;
          }
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === 'd'
          ) {
            event.preventDefault();
            if (!event.repeat) props.toggleDictation();
            return;
          }
          if (commands.keyDown(event)) return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void props.send();
          }
        }}
        placeholder={
          props.currentComposer.skillId
            ? uiText('workspace:composerSkillTaskPlaceholder')
            : props.threadRootId
              ? uiText('workspace:threadComposer')
              : uiText('workspace:text_97c58dddcb9f', {
                  value0: props.conversation?.title || 'Bot',
                })
        }
        rows={1}
        aria-label={uiText(
          props.threadRootId ? 'workspace:threadComposer' : 'workspace:text_387278213e79',
        )}
      />
    </>
  );
}

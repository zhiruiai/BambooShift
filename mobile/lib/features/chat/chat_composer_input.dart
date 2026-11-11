import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'chat_draft_controls.dart';
import 'chat_mentions.dart';
import 'chat_skills.dart';

int syncInboundChatText(
  TextEditingController input,
  WorkspaceController scope,
  String key,
  int knownRevision,
) {
  if (!scope.active) return knownRevision;
  final revision = scope.inboundDraftRevision(key);
  if (revision != knownRevision) {
    final text = scope.chatDraft(key);
    if (input.text != text) {
      input.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      );
    }
  }
  return revision;
}

class ChatComposerInput extends StatelessWidget {
  const ChatComposerInput({
    super.key,
    required this.scope,
    required this.input,
    required this.focus,
    required this.options,
    required this.reply,
    required this.choices,
    required this.skill,
    required this.editable,
    required this.busy,
    required this.onOptions,
    required this.onJump,
    required this.onMention,
    required this.onChanged,
    this.onSend,
    this.compactHeight,
    this.onDictate,
    this.onVoiceCall,
    this.memoSelected = false,
    this.onMemo,
  });

  final WorkspaceController scope;
  final TextEditingController input;
  final FocusNode focus;
  final ChatDraftOptions options;
  final Json? reply;
  final List<ChatMention> choices;
  final ChatSkill? skill;
  final bool editable, busy;
  final ValueChanged<ChatDraftOptions> onOptions;
  final ValueChanged<String> onJump, onChanged;
  final void Function(ChatMention, ChatMentionToken?) onMention;
  final VoidCallback? onSend, onDictate, onVoiceCall;
  final double? compactHeight;
  final bool memoSelected;
  final ValueChanged<bool>? onMemo;

  @override
  Widget build(BuildContext context) {
    final available = availableChatMentions(choices, options);
    final content = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ChatDraftControls(
          options: options,
          reply: reply,
          choices: choices,
          skill: skill,
          botName: (id) {
            final name = scope.find('agents', id)?['name'];
            return name is String ? name : null;
          },
          editable: editable,
          onChange: onOptions,
          onJump: onJump,
        ),
        if (onMemo != null)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: FilterChip(
                label: Text(context.tr('voiceMemoRequest')),
                avatar: const Icon(Icons.graphic_eq, size: 16),
                selected: memoSelected,
                onSelected: onMemo,
              ),
            ),
          ),
        if (editable && focus.hasFocus && available.isNotEmpty)
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: input,
            builder: (_, value, _) {
              final token = chatMentionToken(value);
              return token == null
                  ? const SizedBox.shrink()
                  : ChatMentionSuggestions(
                      scope: scope,
                      choices: available,
                      token: token,
                      onSelect: (choice) => onMention(choice, token),
                    );
            },
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (editable && available.isNotEmpty)
                ChatMentionButton(
                  scope: scope,
                  choices: available,
                  onSelect: (choice) => onMention(choice, null),
                ),
              Expanded(
                child: TextField(
                  controller: input,
                  focusNode: focus,
                  onChanged: onChanged,
                  enabled: editable,
                  minLines: 1,
                  maxLines: compactHeight == null ? 6 : 3,
                  maxLength: 32000,
                  style: const TextStyle(fontSize: 16),
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(
                    hintText: context.tr(
                      options.skillId == null ? 'messageHint' : 'chatSkillTask',
                    ),
                    counterText: '',
                  ),
                ),
              ),
              if (onDictate != null)
                IconButton(
                  tooltip: context.tr('voiceStartDictation'),
                  onPressed: onDictate,
                  icon: const Icon(Icons.mic_none),
                ),
              if (onVoiceCall != null)
                IconButton.filled(
                  tooltip: context.tr('voiceStartCall'),
                  onPressed: onVoiceCall,
                  icon: const Icon(Icons.graphic_eq),
                )
              else ...[
                const SizedBox(width: 8),
                Tooltip(
                  message: context.tr('send'),
                  child: FilledButton(
                    onPressed: onSend,
                    child: busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.arrow_upward),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
    final height = compactHeight;
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: height == null
            ? double.infinity
            : (height - kToolbarHeight).clamp(50, 270).toDouble() * .65,
      ),
      child: SingleChildScrollView(reverse: true, child: content),
    );
  }
}

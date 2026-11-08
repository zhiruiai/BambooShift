import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../l10n/strings.dart';
import 'chat_message_controls.dart';
import 'chat_mentions.dart';

class ChatDraftControls extends StatelessWidget {
  const ChatDraftControls({
    super.key,
    required this.options,
    required this.reply,
    required this.choices,
    required this.onChange,
    required this.onJump,
    required this.editable,
  });

  final ChatDraftOptions options;
  final Json? reply;
  final List<ChatMention> choices;
  final ValueChanged<ChatDraftOptions> onChange;
  final ValueChanged<String> onJump;
  final bool editable;

  @override
  Widget build(BuildContext context) {
    final id = options.replyId;
    final bots = {
      for (final choice in choices)
        if (choice.bot != null) choice.id: choice,
    };
    final selectedBots = selectedChatBotIds(options);
    final app = choices
        .where((choice) => choice.app != null && choice.app == options.app)
        .firstOrNull;
    if (options == emptyChatOptions) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (id != null)
            Row(
              children: [
                Expanded(
                  child: ChatQuote(
                    title: context.tr(
                      reply == null ? 'chatReplyUnavailable' : 'chatReply',
                    ),
                    content: chatExcerpt(context, reply?['content']),
                    onTap: reply == null ? null : () => onJump(id),
                  ),
                ),
                IconButton(
                  tooltip: context.tr('chatClearReply'),
                  onPressed: editable
                      ? () => onChange(options.withReply(null))
                      : null,
                  icon: const Icon(Icons.close, size: 18),
                ),
              ],
            ),
          if (selectedBots.isNotEmpty ||
              options.mentions?.everyone == true ||
              options.app != null)
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  if (options.mentions?.everyone == true)
                    _chip(
                      context,
                      Icons.groups_outlined,
                      '@${context.tr('chatEveryone')}',
                      'chatClearRecipient',
                      () => onChange(removeChatMention(options, null)),
                    ),
                  for (final botId in selectedBots)
                    _chip(
                      context,
                      Icons.alternate_email,
                      bots[botId]?.name ?? context.tr('chatBotUnavailable'),
                      'chatClearRecipient',
                      () => onChange(removeChatMention(options, botId)),
                    ),
                  if (options.app != null)
                    _chip(
                      context,
                      Icons.extension_outlined,
                      app?.name ?? context.tr('chatAppChanged'),
                      'chatClearApp',
                      () => onChange((
                        agentId: options.agentId,
                        replyId: id,
                        app: null,
                        mentions: null,
                      )),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _chip(
    BuildContext context,
    IconData icon,
    String label,
    String tooltip,
    VoidCallback remove,
  ) => Padding(
    padding: const EdgeInsets.only(right: 6),
    child: InputChip(
      avatar: Icon(icon, size: 16),
      label: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 170),
        child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      labelStyle: const TextStyle(fontSize: 12),
      deleteButtonTooltipMessage: context.tr(tooltip),
      onDeleted: editable ? remove : null,
    ),
  );
}

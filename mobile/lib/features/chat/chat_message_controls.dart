import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import 'chat_controller.dart';

String chatExcerpt(BuildContext context, Object? value) {
  final text = value is String ? value.trim() : '';
  if (text.isEmpty) return context.tr('chatMessage');
  return text.length <= 280 ? text : '${text.substring(0, 280)}…';
}

class ChatQuote extends StatelessWidget {
  const ChatQuote({
    super.key,
    required this.title,
    required this.content,
    this.onTap,
  });

  final String title, content;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.format_quote_outlined,
                size: 16,
                color: colors.primary,
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: colors.primary,
                      ),
                    ),
                    Text(
                      content,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ChatMessageControls extends StatelessWidget {
  const ChatMessageControls({
    super.key,
    required this.message,
    required this.userId,
    this.onReply,
    this.onReact,
    this.onThread,
  });

  final Json message;
  final String userId;
  final VoidCallback? onReply;
  final ValueChanged<String>? onReact;
  final VoidCallback? onThread;

  @override
  Widget build(BuildContext context) {
    final displayed = message['reactions'];
    final colors = Theme.of(context).colorScheme;
    return Wrap(
      spacing: 5,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (final emoji in chatReactions)
          if (displayed is List && displayed.contains(emoji))
            _reaction(context, colors, emoji),
        if (onReply != null || onReact != null || onThread != null)
          PopupMenuButton<String>(
            tooltip: context.tr('chatMessageActions'),
            icon: const Icon(Icons.more_horiz, size: 20),
            onSelected: (value) {
              if (value == 'reply') {
                onReply?.call();
              } else if (value == 'thread') {
                onThread?.call();
              } else {
                onReact?.call(value);
              }
            },
            itemBuilder: (context) => [
              if (onReply != null)
                PopupMenuItem(
                  value: 'reply',
                  child: Text(context.tr('chatReply')),
                ),
              if (onThread != null)
                PopupMenuItem(
                  value: 'thread',
                  child: Text(context.tr('chatOpenThread')),
                ),
              if (onReact != null)
                for (final emoji in chatReactions)
                  PopupMenuItem(
                    value: emoji,
                    child: Text('${context.tr(_reactionKey(emoji))} $emoji'),
                  ),
            ],
          ),
      ],
    );
  }

  Widget _reaction(BuildContext context, ColorScheme colors, String emoji) {
    final members = reactionMembers(message, emoji);
    final selected = members.contains(userId);
    return Semantics(
      selected: selected,
      child: ActionChip(
        tooltip: context.tr(_reactionKey(emoji)),
        label: Text(members.isEmpty ? emoji : '$emoji ${members.length}'),
        backgroundColor: selected ? colors.secondaryContainer : null,
        labelStyle: const TextStyle(fontSize: 12),
        onPressed: onReact == null ? null : () => onReact!(emoji),
      ),
    );
  }
}

String _reactionKey(String emoji) => switch (emoji) {
  '👍' => 'chatReactionLike',
  '❤️' => 'chatReactionLove',
  '🎉' => 'chatReactionCelebrate',
  '👀' => 'chatReactionLook',
  _ => 'chatReactionDone',
};

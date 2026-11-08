import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../voice/voice_memo_controller.dart';
import 'chat_message.dart';

class ChatTimeline extends StatelessWidget {
  const ChatTimeline({
    super.key,
    required this.scope,
    required this.messages,
    required this.scroll,
    required this.focus,
    this.onReply,
    this.onReact,
    this.onJump,
    this.onThread,
    this.reactionPending = const {},
    this.memoController,
  });

  final WorkspaceController scope;
  final List<Json> messages;
  final ScrollController scroll;
  final int focus;
  final ValueChanged<Json>? onReply;
  final void Function(String id, String emoji)? onReact;
  final ValueChanged<String>? onJump;
  final ValueChanged<Json>? onThread;
  final Set<String> reactionPending;
  final VoiceMemoController? memoController;

  Widget message(int index, Map<String, int> threadCounts) {
    final row = messages[index];
    final count = threadCounts[row['id']] ?? 0;
    final richCard = row['kind'] != null && row['kind'] != 'text';
    final openThread = onThread == null ? null : () => onThread!(row);
    final child = ChatMessage(
      key: ValueKey('${scope.userId}:${scope.workspaceId}:${row['id']}'),
      scope: scope,
      message: row,
      memoController: memoController,
      onReply: onReply == null ? null : () => onReply!(row),
      onReact:
          row['id'] is! String ||
              reactionPending.contains(row['id']) ||
              onReact == null
          ? null
          : (emoji) => onReact!(row['id'] as String, emoji),
      onJump: onJump,
      onThread: richCard ? null : openThread,
    );
    if (row['kind'] == 'web_research' ||
        openThread == null ||
        (!richCard && count == 0)) {
      return child;
    }
    return Builder(
      builder: (context) {
        final message = richCard
            ? Semantics(
                customSemanticsActions: {
                  CustomSemanticsAction(label: context.tr('chatOpenThread')):
                      openThread,
                },
                child: GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onLongPress: openThread,
                  child: child,
                ),
              )
            : child;
        if (count == 0) return message;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            message,
            TextButton.icon(
              onPressed: openThread,
              icon: const Icon(Icons.forum_outlined, size: 16),
              label: Text('${context.tr('chatThread')} · $count'),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final chatId = messages.firstOrNull?['conversationId'];
    final counts = onThread != null && chatId is String
        ? chatThreadCounts(scope.items('messages'), chatId)
        : const <String, int>{};
    if (focus < 0) {
      return ListView.builder(
        controller: scroll,
        reverse: true,
        padding: const EdgeInsets.all(16),
        itemCount: messages.length,
        itemBuilder: (_, index) => message(messages.length - index - 1, counts),
      );
    }
    // Center the lazy timeline on the hit so old messages need no measured offset.
    const center = ValueKey('focused-chat-messages');
    return CustomScrollView(
      controller: scroll,
      reverse: true,
      center: center,
      anchor: .22,
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          sliver: SliverList.builder(
            itemCount: messages.length - focus - 1,
            itemBuilder: (_, index) => message(focus + index + 1, counts),
          ),
        ),
        SliverPadding(
          key: center,
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
          sliver: SliverList.builder(
            itemCount: focus + 1,
            itemBuilder: (context, index) {
              final child = message(focus - index, counts);
              if (index != 0) return child;
              final colors = Theme.of(context).colorScheme;
              return DecoratedBox(
                key: const ValueKey('focused-chat-message'),
                decoration: BoxDecoration(
                  color: colors.secondaryContainer.withValues(alpha: .4),
                  borderRadius: BorderRadius.circular(18),
                ),
                child: child,
              );
            },
          ),
        ),
      ],
    );
  }
}

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';

class RosterConversation extends StatelessWidget {
  const RosterConversation({
    super.key,
    required this.scope,
    required this.conversation,
    this.onOpen,
    this.trailing,
    this.primary = false,
  });
  final WorkspaceController scope;
  final Json conversation;
  final void Function(String)? onOpen;
  final Widget? trailing;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    final ids = conversation['agentIds'] as List? ?? [];
    final members = [
      for (final id in ids.whereType<String>())
        if (scope.find('agents', id) case final Json bot) bot,
    ];
    final last = scope
        .items('messages')
        .where(
          (message) =>
              message['conversationId'] == conversation['id'] &&
              message['kind'] != 'web_research',
        )
        .lastOrNull;
    final unread = conversation['unread'];
    return Card(
      child: ListTile(
        contentPadding: const EdgeInsets.all(16),
        leading: conversation['isGroup'] == true
            ? BotGroupAvatar(bots: members, scope: scope)
            : BotAvatar(
                bot: members.firstOrNull ?? {},
                family: scope.session.avatarTheme,
                scope: scope,
              ),
        title: Text(
          conversation['title'] as String? ?? '',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: primary
            ? Text(context.tr('primaryBot'))
            : Text(
                last?['content'] as String? ?? '',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
        trailing:
            trailing ??
            (unread is int && unread > 0
                ? Badge(
                    label: Text(
                      unread > 99 ? '99+' : '$unread',
                      style: const TextStyle(fontSize: 12),
                    ),
                    child: const Icon(Icons.chevron_right),
                  )
                : const Icon(Icons.chevron_right)),
        onTap: onOpen == null
            ? null
            : () => onOpen!(conversation['id'] as String),
      ),
    );
  }
}

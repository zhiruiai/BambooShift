import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../widgets/bot_avatar.dart';
import 'action_data.dart';
import 'chat_question_data.dart';

class ChatHeaderTitle extends StatelessWidget {
  const ChatHeaderTitle({
    super.key,
    required this.title,
    required this.scope,
    required this.bot,
    required this.working,
    required this.messages,
    this.threadRootId,
  });

  final String title;
  final WorkspaceController scope;
  final Json? bot;
  final bool working;
  final List<Json> messages;
  final String? threadRootId;

  bool get _hasCurrentAction {
    for (final message in messages.reversed) {
      if (chatThreadRoot(message) != threadRootId) continue;
      if (message['role'] == 'user') return false;
      if (message['role'] != 'assistant') continue;
      if (message['kind'] == 'question') {
        return ChatQuestion.parse(message)?.canAnswer(scope) == true;
      }
      if (message['kind'] == 'approval' || message['kind'] == 'computer') {
        final action = ChatAction.fromMessage(message);
        return action?.status == 'running' ||
            (action?.status == 'pending' &&
                action!.canDecide(scope.userId, scope.owner));
      }
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final label = Text(title, maxLines: 1, overflow: TextOverflow.ellipsis);
    final currentBot = bot;
    if (currentBot == null) return label;
    final active =
        scope.active &&
        !scope.disconnected &&
        botAvailable(currentBot) &&
        ModalRoute.isCurrentOf(context) != false;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        ExcludeSemantics(
          child: BotAvatar(
            key: ValueKey(currentBot['id']),
            bot: currentBot,
            scope: scope,
            family: scope.session.avatarTheme,
            size: 26,
            motion: active && working ? BotAvatarMotion.working : null,
            blinkWhenIdle: active && !working && !_hasCurrentAction,
          ),
        ),
        const SizedBox(width: 8),
        Flexible(child: label),
      ],
    );
  }
}

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../widgets/bot_avatar.dart';
import 'action_data.dart';
import 'chat_avatar_motion.dart';
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

  BotAvatarMotion? get _activity {
    for (final message in messages.reversed) {
      if (chatThreadRoot(message) != threadRootId) continue;
      if (message['role'] == 'user') break;
      if (message['role'] != 'assistant') continue;
      if (message['kind'] == 'question') {
        return ChatQuestion.parse(message)?.canAnswer(scope) == true
            ? BotAvatarMotion.attention
            : null;
      }
      if (message['kind'] == 'approval' || message['kind'] == 'computer') {
        final motion = actionAvatarMotion(
          ChatAction.fromMessage(message),
          scope,
        );
        return motion == BotAvatarMotion.attention ||
                motion == BotAvatarMotion.working
            ? motion
            : null;
      }
      final motion = textAvatarMotion(message);
      return motion?.running == true ? motion : null;
    }
    return null;
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
    final motion = active
        ? _activity ?? (working ? BotAvatarMotion.thinking : null)
        : null;
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
            motion: motion,
            sustainMotion: true,
            blinkWhenIdle: active && motion == null,
          ),
        ),
        const SizedBox(width: 8),
        Flexible(child: label),
      ],
    );
  }
}

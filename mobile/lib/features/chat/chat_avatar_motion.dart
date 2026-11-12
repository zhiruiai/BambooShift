import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../widgets/bot_avatar.dart';
import 'action_data.dart';
import 'shell_action_data.dart';

BotAvatarMotion? actionAvatarMotion(
  ChatAction? action,
  WorkspaceController scope,
) {
  if (action == null) return null;
  final result = action.value['result'];
  return switch (action.status) {
    'pending' when action.canDecide(scope.userId, scope.owner) =>
      BotAvatarMotion.attention,
    'running' => BotAvatarMotion.working,
    'done' when isShellAction(action) => switch (shellResultLabel(result)) {
      'shellCompleted' => BotAvatarMotion.done,
      'shellCancelled' || null => null,
      _ => BotAvatarMotion.error,
    },
    'done' when result is Map && result['isError'] == true =>
      BotAvatarMotion.error,
    'done' => BotAvatarMotion.done,
    'error' => BotAvatarMotion.error,
    _ => null,
  };
}

BotAvatarMotion? textAvatarMotion(Json message) => switch (message['status']) {
  'running'
      when message['metadata']?['streamEnded'] != true &&
          message['content'] is String &&
          (message['content'] as String).isNotEmpty =>
    BotAvatarMotion.working,
  'running' => BotAvatarMotion.thinking,
  'done' => BotAvatarMotion.done,
  'error' => BotAvatarMotion.error,
  _ => null,
};

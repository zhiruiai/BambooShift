import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/action_data.dart';
import 'package:openbot_mobile/features/chat/chat_avatar_motion.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'action_card_support.dart';
import 'support.dart';

void main() {
  test(
    'avatar follows command failure even after shell transport settles',
    () async {
      final f = await fixture((_) async => jsonResponse({}));
      addTearDown(f.session.dispose);
      addTearDown(f.scope.dispose);
      for (final type in ['local_shell', 'remote_shell']) {
        final message = actionMessage(kind: 'computer', status: 'done');
        final action = message['metadata']['action'] as Json;
        action['type'] = type;
        for (final (result, expected) in [
          ({'exitCode': 0}, BotAvatarMotion.done),
          ({'exitCode': 7}, BotAvatarMotion.error),
          ({'timedOut': true, 'exitCode': null}, BotAvatarMotion.error),
          ({'cancelled': true, 'exitCode': null}, null),
        ]) {
          action['result'] = result;
          expect(
            actionAvatarMotion(ChatAction.fromMessage(message), f.scope),
            expected,
          );
        }
      }
    },
  );
}

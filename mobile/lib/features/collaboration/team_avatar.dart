import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/avatar_assets.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';

String? teamAvatarPath(WorkspaceController scope, Json profile) =>
    botAvatarPath(scope, profile);

class TeamAvatar extends StatelessWidget {
  const TeamAvatar({super.key, required this.scope, required this.profile});
  final WorkspaceController scope;
  final Json profile;

  @override
  Widget build(BuildContext context) => BotAvatar(
    bot: profile,
    scope: scope,
    family: scope.session.avatarTheme,
    onUnavailable: (context, fallback) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        fallback,
        Tooltip(
          message: context.tr('mobileCollaborationAvatarUnavailable'),
          child: const Icon(Icons.broken_image_outlined, size: 16),
        ),
      ],
    ),
  );
}

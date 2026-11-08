import 'package:flutter/material.dart';

import '../../core/avatar_preferences.dart';
import '../../widgets/bot_avatar.dart';

class AvatarThemePreview extends StatelessWidget {
  const AvatarThemePreview({super.key, required this.family, this.generated});

  final String family;
  final GeneratedAvatarTheme? generated;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final shape in ['orb', 'gem', 'leaf'])
          BotAvatar(
            bot: {'avatar': shape},
            family: family,
            previewTheme: generated,
            useDeviceTheme: false,
            size: 27,
          ),
      ],
    ),
  );
}

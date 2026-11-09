import 'package:flutter/material.dart';

import '../../core/avatar_preferences.dart';
import '../../widgets/bot_avatar.dart';

class AvatarThemePreview extends StatelessWidget {
  const AvatarThemePreview({
    super.key,
    required this.family,
    this.generated,
    this.selected = false,
  });

  final String family;
  final GeneratedAvatarTheme? generated;
  final bool selected;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: FittedBox(
      fit: BoxFit.scaleDown,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final shape in [
            'orb',
            'leaf',
            generated == null ? 'arch' : 'gem',
          ])
            BotAvatar(
              bot: {'avatar': shape},
              family: family,
              previewTheme: generated,
              useDeviceTheme: false,
              size: 27,
              motion: selected && shape == 'orb'
                  ? BotAvatarMotion.preview
                  : null,
            ),
        ],
      ),
    ),
  );
}

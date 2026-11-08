import 'package:flutter/material.dart';

import '../../core/avatar_preferences.dart';
import '../../l10n/strings.dart';
import 'avatar_theme_preview.dart';

class AvatarThemePicker extends StatelessWidget {
  const AvatarThemePicker({
    super.key,
    required this.selected,
    required this.onChanged,
    this.generated,
    this.generatedSelected = false,
    this.onSelectGenerated,
  });

  final String selected;
  final ValueChanged<String>? onChanged;
  final GeneratedAvatarTheme? generated;
  final bool generatedSelected;
  final VoidCallback? onSelectGenerated;

  @override
  Widget build(BuildContext context) {
    final custom = generated;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          context.tr('avatarTheme'),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(context.tr('avatarThemeHelp')),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) {
            const gap = 8.0;
            final width = constraints.maxWidth;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final family in avatarThemes)
                  _option(
                    context,
                    width: width >= 270 ? (width - gap) / 2 : width,
                    name: context.tr(family),
                    selected: !generatedSelected && selected == family,
                    preview: AvatarThemePreview(family: family),
                    onTap: onChanged == null ? null : () => onChanged!(family),
                  ),
                if (custom != null)
                  _option(
                    context,
                    width: width >= 270 ? (width - gap) / 2 : width,
                    name: custom.name,
                    selected: generatedSelected,
                    preview: AvatarThemePreview(
                      family: custom.motif,
                      generated: custom,
                    ),
                    onTap: onSelectGenerated,
                  ),
              ],
            );
          },
        ),
      ],
    );
  }

  Widget _option(
    BuildContext context, {
    required double width,
    required String name,
    required bool selected,
    required Widget preview,
    required VoidCallback? onTap,
  }) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      width: width,
      child: Semantics(
        selected: selected,
        button: true,
        child: Material(
          color: selected ? colors.secondaryContainer : colors.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: BorderSide(
              color: selected ? colors.primary : colors.outlineVariant,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
              child: Column(
                children: [
                  preview,
                  const SizedBox(height: 4),
                  Text(name, textAlign: TextAlign.center),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

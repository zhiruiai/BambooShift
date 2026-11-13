import 'package:flutter/material.dart';

import '../../core/avatar_preferences.dart';
import '../../core/avatar_palette.dart';
import '../../core/community_avatar_catalog.g.dart';
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
            final columns = width >= 456
                ? 3
                : width >= 270
                ? 2
                : 1;
            final optionWidth = (width - (columns - 1) * gap) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final family in [
                  defaultAvatarTheme,
                  ...originalAvatarThemes,
                ])
                  _option(
                    context,
                    width: optionWidth,
                    horizontal: columns == 1,
                    name: context.tr(family),
                    selected: !generatedSelected && selected == family,
                    preview: AvatarThemePreview(
                      family: family,
                      selected: !generatedSelected && selected == family,
                    ),
                    onTap: onChanged == null ? null : () => onChanged!(family),
                  ),
                if (custom != null)
                  _option(
                    context,
                    width: optionWidth,
                    horizontal: columns == 1,
                    name: custom.name,
                    selected: generatedSelected,
                    preview: AvatarThemePreview(
                      family: custom.motif,
                      generated: custom,
                      selected: generatedSelected,
                    ),
                    onTap: onSelectGenerated,
                  ),
              ],
            );
          },
        ),
        const SizedBox(height: 16),
        for (final group in ['open-avatar', 'grokbot'])
          _communityGroup(context, group),
      ],
    );
  }

  Widget _communityGroup(BuildContext context, String group) {
    final themes = communityAvatarThemes
        .where((theme) => communityAvatarGroups[theme] == group)
        .toList();
    final language = Localizations.localeOf(context).languageCode;
    final name = group == 'open-avatar'
        ? 'Open Bot Avatar'
        : language == 'zh'
        ? '社区 GrokBot'
        : 'Community GrokBot';
    return ExpansionTile(
      key: PageStorageKey('avatar-pack-$group'),
      tilePadding: EdgeInsets.zero,
      title: Text(name, style: Theme.of(context).textTheme.titleSmall),
      subtitle: Text(
        '${themes.length} · ${group == 'open-avatar' ? 'MIT' : 'BSD-3-Clause'}',
      ),
      initiallyExpanded: communityAvatarGroups[selected] == group,
      childrenPadding: const EdgeInsets.only(bottom: 16),
      children: [
        LayoutBuilder(
          builder: (context, constraints) {
            const gap = 8.0;
            final columns = constraints.maxWidth >= 456
                ? 3
                : constraints.maxWidth >= 270
                ? 2
                : 1;
            final width =
                (constraints.maxWidth - (columns - 1) * gap) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final theme in themes)
                  _option(
                    context,
                    width: width,
                    horizontal: columns == 1,
                    name: context.tr(theme),
                    selected: !generatedSelected && selected == theme,
                    preview: AvatarThemePreview(
                      family: theme,
                      selected: !generatedSelected && selected == theme,
                    ),
                    onTap: onChanged == null ? null : () => onChanged!(theme),
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
    required bool horizontal,
    required String name,
    required bool selected,
    required Widget preview,
    required VoidCallback? onTap,
  }) {
    final colors = Theme.of(context).colorScheme;
    final selection = ColorScheme.fromSeed(
      seedColor: avatarColorValue(defaultAvatarColor),
      brightness: Theme.of(context).brightness,
    );
    final caption = Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Flexible(
          child: Text(
            name,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: selected ? selection.onPrimaryContainer : colors.onSurface,
              fontWeight: selected ? FontWeight.w600 : null,
            ),
          ),
        ),
        if (selected)
          Padding(
            padding: const EdgeInsetsDirectional.only(start: 4),
            child: Icon(Icons.check, size: 15, color: selection.primary),
          ),
      ],
    );
    return SizedBox(
      width: width,
      child: Semantics(
        selected: selected,
        button: true,
        child: Material(
          color: selected ? selection.primaryContainer : colors.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: BorderSide(
              color: selected ? selection.primary : colors.outlineVariant,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
              child: horizontal
                  ? Row(
                      children: [
                        SizedBox(width: width * .36, child: preview),
                        const SizedBox(width: 8),
                        Expanded(child: caption),
                      ],
                    )
                  : Column(
                      children: [preview, const SizedBox(height: 4), caption],
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

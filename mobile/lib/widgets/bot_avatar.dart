import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../core/api.dart';
import '../core/avatar_assets.dart';
import '../core/avatar_palette.dart';
import '../core/avatar_preferences.dart';
import '../core/byte_read.dart';
import '../core/classic_avatar.g.dart';
import '../core/community_avatar_catalog.g.dart';
import '../core/workspace_controller.dart';
import 'avatar_appearance.dart';
import 'avatar_face.dart';
import 'avatar_pack_face.dart';

// Base fills in the SVGs produced by scripts/export-avatars.ts.
const _exportedColors = {
  'orb': Color(0xff8b5cf6),
  'drop': Color(0xff4088f3),
  'leaf': Color(0xff24b78c),
  'arch': Color(0xfffb8742),
  'spark': Color(0xffe9ae38),
  'gem': Color(0xffed7299),
};

enum BotAvatarMotion {
  thinking,
  working,
  attention,
  done,
  error,
  preview;

  bool get running => this == thinking || this == working;
  bool get terminal => this == done || this == error;
}

class BotAvatar extends StatelessWidget {
  const BotAvatar({
    super.key,
    required this.bot,
    required this.family,
    this.size = 44,
    this.scope,
    this.onUnavailable,
    this.previewTheme,
    this.useDeviceTheme = true,
    this.motion,
    this.sustainMotion = false,
    this.blinkWhenIdle = false,
  });
  final Json bot;
  final String family;
  final double size;
  final WorkspaceController? scope;
  final Widget Function(BuildContext context, Widget fallback)? onUnavailable;
  final GeneratedAvatarTheme? previewTheme;
  final bool useDeviceTheme;
  final BotAvatarMotion? motion;
  final bool sustainMotion;
  final bool blinkWhenIdle;
  @override
  Widget build(BuildContext context) {
    final candidate = bot['avatar'];
    final shape = candidate is String && _exportedColors.containsKey(candidate)
        ? candidate
        : 'orb';
    final appearance = useDeviceTheme ? AvatarAppearance.of(context) : null;
    final generated =
        previewTheme ??
        (appearance?.useCustomAvatarTheme == true
            ? appearance?.customAvatarTheme
            : null);
    final theme =
        generated?.motif ?? validAvatarTheme(appearance?.avatarTheme ?? family);
    final classic = theme == classicAvatarTheme;
    final renderedTheme = classic ? classicAvatarShapes[shape]! : theme;
    final base = _exportedColors[shape]!;
    final hex = generated?.colorFor(shape) ?? bot['color'];
    final color = classic
        ? const Color(classicAvatarColor)
        : avatarColorValue(
            displayAvatarColor(hex, fallback: avatarRoleColors[shape]!),
          );
    final workspace = scope;
    final path = workspace == null ? null : botAvatarPath(workspace, bot);
    final community = communityAvatarThemes.contains(renderedTheme);
    final animate = path == null && bot['avatarImageId'] == null;
    final asset = 'assets/avatars/$theme/$shape.svg';
    final mapper = AvatarColorMapper(color, baseColor: base);
    final original = SvgPicture.asset(
      asset,
      colorMapper: mapper,
      semanticsLabel: bot['name'] as String?,
    );
    final glyph = community
        ? AvatarPackFace(
            theme: renderedTheme,
            color: color,
            outlineColor:
                classic && Theme.of(context).brightness == Brightness.dark
                ? const Color(0xff777777)
                : null,
            state: motion?.name ?? 'idle',
            sustain: animate && sustainMotion,
            blinkWhenIdle:
                animate && (blinkWhenIdle || classic && motion == null),
            repeatIdleBlink: animate && classic && blinkWhenIdle,
            label: bot['name'] as String?,
          )
        : path == null &&
              bot['avatarImageId'] == null &&
              (motion != null || blinkWhenIdle)
        ? AvatarFace(
            key: ValueKey((asset, mapper)),
            asset: asset,
            theme: theme,
            shape: shape,
            colorMapper: mapper,
            fallback: original,
            state: motion?.name ?? 'idle',
            sustain: sustainMotion,
            blinkWhenIdle: blinkWhenIdle,
            label: bot['name'] as String?,
          )
        : original;
    final artwork = generated == null
        ? glyph
        : GeneratedAvatarDecoration(
            theme: generated,
            color: color,
            child: glyph,
          );
    final fallback = SizedBox.square(dimension: size, child: artwork);
    if (workspace == null || path == null) return fallback;
    return _AvatarImage(
      key: ValueKey((workspace, path)),
      scope: workspace,
      path: path,
      size: size,
      label: bot['name'] as String?,
      fallback: fallback,
      onUnavailable: onUnavailable,
    );
  }
}

class _AvatarImage extends StatefulWidget {
  const _AvatarImage({
    super.key,
    required this.scope,
    required this.path,
    required this.size,
    required this.label,
    required this.fallback,
    this.onUnavailable,
  });

  final WorkspaceController scope;
  final String path;
  final double size;
  final String? label;
  final Widget fallback;
  final Widget Function(BuildContext context, Widget fallback)? onUnavailable;

  @override
  State<_AvatarImage> createState() => _AvatarImageState();
}

class _AvatarImageState extends State<_AvatarImage> {
  final cancellation = ByteReadCancellation();
  MemoryImage? image;
  bool failed = false;

  bool get current => mounted && widget.scope.active && !cancellation.cancelled;

  @override
  void initState() {
    super.initState();
    widget.scope.session.addListener(_identityChanged);
    unawaited(_load());
  }

  void _identityChanged() {
    if (widget.scope.active) return;
    cancellation.cancel();
    _evict();
    if (mounted) setState(() => failed = false);
  }

  Future<void> _load() async {
    if (!current) return;
    try {
      final data = await readAvatarImage(
        widget.scope,
        widget.path,
        current: () => current,
        cancellation: cancellation,
      );
      if (current) setState(() => image = MemoryImage(data));
    } catch (_) {
      if (current) setState(() => failed = true);
    }
  }

  void _evict() {
    final previous = image;
    image = null;
    if (previous != null) unawaited(previous.evict());
  }

  @override
  void dispose() {
    cancellation.cancel();
    _evict();
    widget.scope.session.removeListener(_identityChanged);
    super.dispose();
  }

  Widget _fallback(BuildContext context) =>
      widget.onUnavailable?.call(context, widget.fallback) ?? widget.fallback;

  @override
  Widget build(BuildContext context) {
    final value = current ? image : null;
    if (value == null) return failed ? _fallback(context) : widget.fallback;
    return ClipRRect(
      borderRadius: BorderRadius.circular(widget.size * .28),
      child: Image(
        image: value,
        width: widget.size,
        height: widget.size,
        fit: BoxFit.cover,
        semanticLabel: widget.label,
        errorBuilder: (context, _, _) => _fallback(context),
      ),
    );
  }
}

class BotGroupAvatar extends StatelessWidget {
  const BotGroupAvatar({super.key, required this.bots, required this.scope});

  final List<Json> bots;
  final WorkspaceController scope;

  @override
  Widget build(BuildContext context) {
    if (bots.isEmpty) {
      return CircleAvatar(
        backgroundColor: Theme.of(context).colorScheme.secondaryContainer,
        child: const Icon(Icons.groups_outlined),
      );
    }
    const positions = [Offset(0, 0), Offset(17, 2), Offset(8, 17)];
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: 44,
        child: Stack(
          children: [
            for (final (index, bot) in bots.take(3).indexed)
              Positioned(
                left: positions[index].dx,
                top: positions[index].dy,
                child: BotAvatar(
                  bot: bot,
                  family: scope.session.avatarTheme,
                  scope: scope,
                  size: 26,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class AvatarColorMapper extends ColorMapper {
  const AvatarColorMapper(
    this.color, {
    this.baseColor = const Color(0xff8b5cf6),
  });
  final Color color;
  final Color baseColor;
  @override
  Color substitute(
    String? id,
    String elementName,
    String attributeName,
    Color original,
  ) => original == baseColor ? color : original;
  @override
  bool operator ==(Object other) =>
      other is AvatarColorMapper &&
      other.color == color &&
      other.baseColor == baseColor;
  @override
  int get hashCode => Object.hash(color, baseColor);
}

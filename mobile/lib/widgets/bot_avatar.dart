import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../core/api.dart';
import '../core/avatar_assets.dart';
import '../core/avatar_preferences.dart';
import '../core/byte_read.dart';
import '../core/workspace_controller.dart';
import 'avatar_appearance.dart';
import 'idle_avatar_blink.dart';

// Base fills in the SVGs produced by scripts/export-avatars.ts.
const _exportedColors = {
  'orb': Color(0xff8b5cf6),
  'drop': Color(0xff4088f3),
  'leaf': Color(0xff24b78c),
  'arch': Color(0xfffb8742),
  'spark': Color(0xffe9ae38),
  'gem': Color(0xffed7299),
};

enum BotAvatarMotion { working, attention, done, preview }

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
    final base = _exportedColors[shape]!;
    final hex = generated?.colorFor(shape) ?? bot['color'];
    final color = hex is String && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(hex)
        ? Color(int.parse(hex.substring(1), radix: 16) | 0xff000000)
        : base;
    final workspace = scope;
    final path = workspace == null ? null : botAvatarPath(workspace, bot);
    final asset = 'assets/avatars/$theme/$shape.svg';
    final mapper = AvatarColorMapper(color, baseColor: base);
    final original = SvgPicture.asset(
      asset,
      colorMapper: mapper,
      semanticsLabel: bot['name'] as String?,
    );
    final glyph =
        blinkWhenIdle &&
            motion == null &&
            path == null &&
            bot['avatarImageId'] == null &&
            MediaQuery.maybeDisableAnimationsOf(context) != true
        ? IdleAvatarBlink(
            key: ValueKey((asset, mapper)),
            asset: asset,
            colorMapper: mapper,
            fallback: original,
          )
        : original;
    final artwork = generated == null
        ? glyph
        : GeneratedAvatarDecoration(
            theme: generated,
            color: color,
            child: glyph,
          );
    final fallback = SizedBox.square(
      dimension: size,
      child: path == null && motion != null
          ? _AvatarReaction(
              key: ValueKey((theme, shape, color)),
              motion: motion!,
              size: size,
              child: artwork,
            )
          : artwork,
    );
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

class _AvatarReaction extends StatefulWidget {
  const _AvatarReaction({
    super.key,
    required this.motion,
    required this.size,
    required this.child,
  });

  final BotAvatarMotion motion;
  final double size;
  final Widget child;

  @override
  State<_AvatarReaction> createState() => _AvatarReactionState();
}

class _AvatarReactionState extends State<_AvatarReaction> {
  bool justFinished = false;

  @override
  void didUpdateWidget(_AvatarReaction oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.motion != widget.motion) {
      justFinished =
          widget.motion == BotAvatarMotion.done &&
          oldWidget.motion == BotAvatarMotion.working;
    }
  }

  @override
  Widget build(BuildContext context) {
    final motion = widget.motion;
    if (MediaQuery.maybeDisableAnimationsOf(context) == true ||
        (motion == BotAvatarMotion.done && !justFinished)) {
      return widget.child;
    }
    return TweenAnimationBuilder<double>(
      key: ValueKey(motion),
      duration: Duration(
        milliseconds: switch (motion) {
          BotAvatarMotion.working => 1700,
          BotAvatarMotion.attention => 620,
          BotAvatarMotion.done => 480,
          BotAvatarMotion.preview => 520,
        },
      ),
      tween: Tween(begin: 0, end: 1),
      child: widget.child,
      builder: (context, progress, child) {
        final phase = progress * math.pi;
        final transform = Matrix4.identity();
        switch (motion) {
          case BotAvatarMotion.working:
            final breath = math.sin(2 * phase);
            final lift = breath * breath;
            final scale = 1 + .07 * lift;
            transform
              ..translateByDouble(0, -.06 * widget.size * lift, 0, 1)
              ..scaleByDouble(scale, scale, 1, 1);
          case BotAvatarMotion.attention:
            transform.rotateZ(-.16 * math.sin(4 * phase));
          case BotAvatarMotion.done:
            if (progress < .5) {
              transform.translateByDouble(
                0,
                -.09 * widget.size * math.sin(2 * phase),
                0,
                1,
              );
            } else {
              final settle = -math.sin(2 * phase);
              transform.scaleByDouble(1 + .08 * settle, 1 - .09 * settle, 1, 1);
            }
          case BotAvatarMotion.preview:
            transform
              ..translateByDouble(0, -.06 * widget.size * math.sin(phase), 0, 1)
              ..rotateZ(-.12 * math.sin(2 * phase));
        }
        return Transform(
          transform: transform,
          alignment: Alignment.center,
          child: child,
        );
      },
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

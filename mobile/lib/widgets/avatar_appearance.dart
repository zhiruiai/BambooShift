import 'package:flutter/material.dart';

import '../core/app_session.dart';
import '../core/avatar_preferences.dart';

class AvatarAppearance extends InheritedNotifier<AppSession> {
  const AvatarAppearance({
    super.key,
    required AppSession session,
    required super.child,
  }) : super(notifier: session);

  static AppSession? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AvatarAppearance>()?.notifier;
}

class GeneratedAvatarDecoration extends StatelessWidget {
  const GeneratedAvatarDecoration({
    super.key,
    required this.theme,
    required this.color,
    required this.child,
  });

  final GeneratedAvatarTheme theme;
  final Color color;
  final Widget child;

  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      if (theme.backdrop != 'plain')
        DecoratedBox(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: theme.backdrop == 'solid'
                ? color.withValues(alpha: .23)
                : null,
            border: Border.all(color: color.withValues(alpha: .55)),
          ),
        ),
      if (theme.backdrop == 'plain')
        child
      else
        FractionallySizedBox(
          widthFactor: .875,
          heightFactor: .875,
          child: child,
        ),
      if (theme.badge != 'none')
        Align(
          alignment: Alignment.bottomRight,
          child: FractionallySizedBox(
            widthFactor: .32,
            heightFactor: .32,
            child: CustomPaint(painter: _ThemeBadge(theme.badge)),
          ),
        ),
    ],
  );
}

class _ThemeBadge extends CustomPainter {
  const _ThemeBadge(this.shape);

  final String shape;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 28, size.height / 28);
    const center = Offset(14, 14);
    canvas.drawCircle(center, 13, Paint()..color = const Color(0xff29253a));
    canvas.drawCircle(
      center,
      13,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5,
    );
    canvas.translate(5, 5);
    canvas.scale(.75, .75);
    final path = switch (shape) {
      'star' =>
        Path()..addPolygon(const [
          Offset(12, 2),
          Offset(15, 8),
          Offset(22, 9),
          Offset(17, 14),
          Offset(18, 21),
          Offset(12, 18),
          Offset(6, 21),
          Offset(7, 14),
          Offset(2, 9),
          Offset(9, 8),
        ], true),
      'flower' =>
        Path()
          ..moveTo(12, 8)
          ..cubicTo(6, 0, 1, 7, 7, 12)
          ..cubicTo(0, 17, 7, 23, 12, 17)
          ..cubicTo(17, 23, 24, 17, 17, 12)
          ..cubicTo(23, 7, 18, 0, 12, 8)
          ..close(),
      'moon' =>
        Path()
          ..moveTo(19, 17)
          ..arcToPoint(
            const Offset(10, 3),
            radius: const Radius.circular(9),
            largeArc: true,
          )
          ..arcToPoint(
            const Offset(19, 17),
            radius: const Radius.circular(8),
            clockwise: false,
          )
          ..close(),
      _ =>
        Path()..addPolygon(const [
          Offset(14, 2),
          Offset(4, 14),
          Offset(10, 14),
          Offset(9, 22),
          Offset(20, 9),
          Offset(14, 9),
        ], true),
    };
    canvas.drawPath(path, Paint()..color = Colors.white);
  }

  @override
  bool shouldRepaint(_ThemeBadge oldDelegate) => shape != oldDelegate.shape;
}

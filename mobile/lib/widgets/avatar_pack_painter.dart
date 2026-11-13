import 'package:flutter/material.dart';

import 'avatar_pack_geometry.dart';

class AvatarPackPainter extends CustomPainter {
  const AvatarPackPainter({
    required this.shape,
    required this.rings,
    required this.color,
    required this.blink,
    required this.gaze,
    this.outlineColor,
  });
  final AvatarPackShape shape;
  final AvatarEyeRings rings;
  final Color color;
  final Color? outlineColor;
  final double blink;
  final Offset gaze;

  @override
  void paint(Canvas canvas, Size size) {
    final side = size.shortestSide;
    canvas
      ..save()
      ..translate((size.width - side) / 2, (size.height - side) / 2)
      ..scale(side / 100)
      ..drawPath(shape.body, Paint()..color = color);
    final outline = outlineColor;
    if (outline != null) {
      canvas.drawPath(
        shape.body,
        Paint()
          ..color = outline
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.2,
      );
    }
    canvas.clipPath(shape.body);
    final paint = Paint()..color = shape.pack.eyeColor;
    for (final ring in displayEyeRings(rings, gaze, blink)) {
      canvas.drawPath(Path()..addPolygon(ring, true), paint);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(AvatarPackPainter oldDelegate) =>
      oldDelegate.shape != shape ||
      oldDelegate.rings != rings ||
      oldDelegate.color != color ||
      oldDelegate.outlineColor != outlineColor ||
      oldDelegate.blink != blink ||
      oldDelegate.gaze != gaze;
}

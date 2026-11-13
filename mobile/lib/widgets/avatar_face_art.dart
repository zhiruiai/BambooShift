import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'avatar_face_geometry.dart';

/// Split only the controlled bundled SVG format. Uploaded images never enter this path.
List<String>? splitAvatarFace(String svg) {
  final eyes = RegExp(r'<g class="avatar-eyes"[^>]*>').firstMatch(svg);
  final open = svg.indexOf('>');
  final close = svg.lastIndexOf('</svg>');
  if (eyes == null || open < 0 || close <= eyes.end) return null;
  var depth = 1;
  for (final tag in RegExp(r'</?g(?:\s[^>]*)?>').allMatches(svg, eyes.end)) {
    depth += tag[0] == '</g>' ? -1 : 1;
    if (depth != 0) continue;
    final inner = svg.substring(eyes.end, tag.start);
    final group = eyes[0]!;
    final patches = RegExp(
      r'<ellipse\b[^>]*(?:/>|>\s*</ellipse>)',
    ).allMatches(inner).map((match) => match[0]).join();
    final brows = RegExp(
      r'<path\b[^>]*(?:/>|>\s*</path>)',
    ).allMatches(inner).map((match) => match[0]).join();
    final head = svg.substring(0, open + 1);
    return [
      '$head${svg.substring(open + 1, eyes.start)}'
          '$group<g fill="#292733">$patches</g></g></svg>',
      '$head$group$brows</g>${svg.substring(tag.end, close)}</svg>',
    ];
  }
  return null;
}

class AvatarFacePainter extends CustomPainter {
  const AvatarFacePainter({
    required this.layers,
    required this.theme,
    required this.shape,
    required this.pose,
    required this.gaze,
    required this.blink,
  });
  final List<PictureInfo> layers;
  final Map<String, dynamic> theme;
  final String shape;
  final AvatarEyePose pose;
  final Offset gaze;
  final double blink;

  @override
  void paint(Canvas canvas, Size size) {
    final bounds = layers.first.size;
    canvas
      ..save()
      ..scale(size.width / bounds.width, size.height / bounds.height)
      ..drawPicture(layers[0].picture)
      ..save()
      ..scale(bounds.width / 64, bounds.height / 64)
      ..translate(32, 31)
      ..rotate(avatarEyeTilt(theme, shape) * 3.141592653589793 / 180)
      ..translate(-32, -31);
    final pupils = theme['pupil'] as List<dynamic>?;
    final eyes = theme['eyes'] as List<dynamic>;
    for (var index = 0; index < eyes.length; index++) {
      final eye = eyes[index] as List<dynamic>;
      final path = avatarEyePath(
        eye,
        pose,
        index,
        blink: blink,
        translation: pupils == null ? gaze * .36 : Offset.zero,
      );
      canvas.drawPath(path, Paint()..color = avatarEyeColor(theme['paper']));
      if (pupils == null || blink > .68 || pose['pupilOpacity'] <= .001) {
        continue;
      }
      final width = (pupils[0] as num).toDouble();
      final height = (pupils[1] as num).toDouble();
      final offset =
          (theme['pupilOffsetX'][index] as num).toDouble() -
          (theme['shapeTilt'] == true && shape == 'drop' ? 1 : 0);
      final centerX = (eye[0] as num).toDouble();
      final eyeWidth = (eye[2] as num).toDouble() * pose['width'];
      final x = (centerX + offset + gaze.dx - width / 2).clamp(
        centerX - eyeWidth / 2 + .35,
        centerX + eyeWidth / 2 - width - .35,
      );
      final y =
          (eye[1] as num).toDouble() +
          (theme['pupilOffsetY'] as num).toDouble() +
          gaze.dy -
          height / 2;
      canvas
        ..save()
        ..clipPath(path)
        ..drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(x, y, width, height),
            Radius.circular(width / 2),
          ),
          Paint()
            ..color = avatarEyeColor(
              theme['ink'],
            ).withValues(alpha: pose['pupilOpacity']),
        )
        ..restore();
    }
    canvas
      ..restore()
      ..drawPicture(layers[1].picture)
      ..restore();
  }

  @override
  bool shouldRepaint(AvatarFacePainter old) =>
      old.pose != pose ||
      old.blink != blink ||
      old.gaze != gaze ||
      old.layers != layers ||
      old.theme != theme ||
      old.shape != shape;
}

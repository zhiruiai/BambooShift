import 'dart:convert';
import 'dart:ui';

import 'package:flutter/services.dart';
import 'package:path_parsing/path_parsing.dart';

typedef AvatarEyeRings = List<List<Offset>>;

/// The same offline source geometry drives Web and Flutter.
class AvatarPackGeometry {
  AvatarPackGeometry(this.manifest, this.expressions);
  final Map<String, dynamic> manifest;
  final Map<String, dynamic> expressions;
  final _shapes = <String, AvatarPackShape>{};
  static final _cache = Expando<Map<String, Future<AvatarPackGeometry>>>();

  static Future<AvatarPackGeometry> load(AssetBundle bundle, String family) {
    final cache = _cache[bundle] ??= {};
    return cache.putIfAbsent(family, () async {
      try {
        final values = await Future.wait([
          bundle.loadString('assets/avatars/packs/$family/manifest.json'),
          bundle.loadString('assets/avatars/packs/$family/expressions.json'),
        ]);
        return AvatarPackGeometry(
          jsonDecode(values[0]) as Map<String, dynamic>,
          jsonDecode(values[1]) as Map<String, dynamic>,
        );
      } catch (_) {
        cache.remove(family);
        rethrow;
      }
    });
  }

  AvatarPackShape shape(String id) => _shapes.putIfAbsent(
    id,
    () => AvatarPackShape(this, manifest['shapes'][id] as Map<String, dynamic>),
  );

  String nativeState(String state) => switch (state) {
    'preview' || 'attention' => family == 'grokbot' ? 'alerting' : 'thinking',
    'done' => family == 'grokbot' ? 'celebrate' : 'happy',
    'error' => family == 'grokbot' ? 'sad' : 'thinking',
    'working' => family == 'grokbot' ? 'working' : 'thinking',
    'thinking' => 'thinking',
    _ => 'idle',
  };

  String get family => manifest['id'] as String;
  double motion(String key, double fallback) =>
      (manifest['motion'][key] as num?)?.toDouble() ?? fallback;
  double get gazeX => (manifest['motion']['gazeMax'][0] as num).toDouble();
  Color get eyeColor => Color(
    int.parse((manifest['eyeColor'] as String).substring(1), radix: 16) |
        0xff000000,
  );
}

class AvatarPackShape {
  AvatarPackShape(this.pack, this.descriptor) {
    final proxy = _SvgPath();
    writeSvgPathDataToPath(descriptor['body']['path'] as String, proxy);
    body = proxy.path;
  }
  final AvatarPackGeometry pack;
  final Map<String, dynamic> descriptor;
  late final Path body;
  final _poses = <String, AvatarEyeRings>{};

  List<String> expressionIds(String state) {
    final native = pack.nativeState(state);
    if (pack.family == 'open-avatar') {
      return [descriptor['expressions'][native] as String];
    }
    return (pack.manifest['states'][native]['expressions'] as List)
        .cast<String>();
  }

  double cadence(String state) {
    final native = pack.manifest['states'][pack.nativeState(state)];
    final cadence = native['expressionCadenceMs'] as List?;
    return cadence == null
        ? 4200
        : ((cadence[0] as num) + (cadence[1] as num)) / 2;
  }

  double blinkSlot(String state) {
    final native = pack.manifest['states'][pack.nativeState(state)];
    final cadence = native['blinkCadenceMs'] as List?;
    return cadence == null
        ? pack.motion('blinkSlotMs', 4200)
        : ((cadence[0] as num) + (cadence[1] as num)) / 2;
  }

  AvatarEyeRings pose(String expression) => _poses.putIfAbsent(expression, () {
    final matrix = (descriptor['eyeTransform'] as List).cast<num>();
    final scale = (descriptor['eyeScale'] as num).toDouble();
    return (pack.expressions[expression] as List)
        .map((raw) {
          final points = (raw as List)
              .map((p) {
                final x = (p[0] as num).toDouble(),
                    y = (p[1] as num).toDouble();
                return Offset(
                  matrix[0] * x + matrix[2] * y + matrix[4],
                  matrix[1] * x + matrix[3] * y + matrix[5],
                );
              })
              .toList(growable: false);
          final center = eyeCenter(points);
          return points
              .map((p) => center + (p - center) * scale)
              .toList(growable: false);
        })
        .toList(growable: false);
  });
}

Offset eyeCenter(List<Offset> points) =>
    points.fold(Offset.zero, (sum, point) => sum + point) /
    points.length.toDouble();

AvatarEyeRings blendEyeRings(AvatarEyeRings a, AvatarEyeRings b, double t) => [
  for (var eye = 0; eye < 2; eye++)
    [for (var i = 0; i < 48; i++) Offset.lerp(a[eye][i], b[eye][i], t)!],
];

AvatarEyeRings displayEyeRings(
  AvatarEyeRings rings,
  Offset gaze,
  double blink,
) => rings
    .map((ring) {
      final center = eyeCenter(ring);
      return ring
          .map(
            (point) => Offset(
              point.dx + gaze.dx,
              center.dy + (point.dy - center.dy) * (1 - blink * .96) + gaze.dy,
            ),
          )
          .toList(growable: false);
    })
    .toList(growable: false);

class _SvgPath extends PathProxy {
  final path = Path();
  @override
  void moveTo(double x, double y) => path.moveTo(x, y);
  @override
  void lineTo(double x, double y) => path.lineTo(x, y);
  @override
  void cubicTo(
    double x1,
    double y1,
    double x2,
    double y2,
    double x3,
    double y3,
  ) => path.cubicTo(x1, y1, x2, y2, x3, y3);
  @override
  void close() => path.close();
}

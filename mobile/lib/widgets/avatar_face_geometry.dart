// Eye-pose interpolation and gaze smoothing adapted from BoopFace (MIT).
// Copyright (c) 2026 CX ART Lab. See assets/licenses/boopface-LICENSE.txt.
// Source: CX-ArtLab/BoopFace@24ee5f698e58fa4f131b5ae7827373814e191f4c,
// src/boopface-core.js and embedded/lib/BoopFace/src/BoopFaceGaze.h.
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';

class AvatarEyePose {
  AvatarEyePose(Map<String, dynamic> values)
    : values = values.map(
        (key, value) => MapEntry(key, (value as num).toDouble()),
      );
  AvatarEyePose._(this.values);
  final Map<String, double> values;
  double operator [](String key) => values[key]!;
  AvatarEyePose blend(AvatarEyePose to, double amount) => AvatarEyePose._({
    for (final key in values.keys)
      key: this[key] + (to[key] - this[key]) * amount,
  });
}

class AvatarFaceRules {
  AvatarFaceRules._(this.data);
  final Map<String, dynamic> data;
  static final _cache = Expando<AvatarFaceRules>();
  static Future<AvatarFaceRules> load(AssetBundle bundle) async {
    final previous = _cache[bundle];
    if (previous != null) return previous;
    final source = await bundle.loadString(
      'assets/avatars/avatar-face-motion.json',
    );
    final rules = AvatarFaceRules._(jsonDecode(source) as Map<String, dynamic>);
    _cache[bundle] = rules;
    return rules;
  }

  AvatarEyePose pose(String state) => AvatarEyePose(data['poses'][state]);
  Map<String, dynamic> theme(String name) => data['themes'][name];
  double motion(String key) => (data['motion'][key] as num).toDouble();
  double ease(double progress) =>
      1 - math.pow(1 - progress.clamp(0, 1), motion('easingPower')).toDouble();
  double gaze(double current, double target, double dt) =>
      (current - target).abs() < .025
      ? target
      : current + (target - current) * dt / (motion('gazeSmoothingMs') + dt);
}

double avatarEyeTilt(Map<String, dynamic> theme, String shape) =>
    theme['shapeTilt'] != true
    ? 0
    : switch (shape) {
        'leaf' => -8,
        'gem' => 7,
        _ => 0,
      };

/// Shared normalized cubic geometry, drawn in the original 64-unit SVG space.
Path avatarEyePath(
  List<dynamic> eye,
  AvatarEyePose pose,
  int index, {
  double blink = 0,
  Offset translation = Offset.zero,
}) {
  final x = (eye[0] as num).toDouble() + translation.dx;
  final y = (eye[1] as num).toDouble() + translation.dy;
  final w = (eye[2] as num).toDouble() * pose['width'];
  final h = (eye[3] as num).toDouble() / 2 * (1 - .88 * blink);
  final t = pose['tilt'] * (index == 0 ? 1 : -1);
  final left = Offset(x - w / 2, y + h * (pose['side'] - t));
  final right = Offset(x + w / 2, y + h * (pose['side'] + t));
  return Path()
    ..moveTo(left.dx, left.dy)
    ..cubicTo(
      x - w * .42,
      y + h * (pose['top'] - t),
      x + w * .42,
      y + h * (pose['top'] + t),
      right.dx,
      right.dy,
    )
    ..cubicTo(
      x + w * .42,
      y + h * (pose['bottom'] + t),
      x - w * .42,
      y + h * (pose['bottom'] - t),
      left.dx,
      left.dy,
    )
    ..close();
}

Color avatarEyeColor(String value) =>
    Color(int.parse(value.substring(1), radix: 16) | 0xff000000);

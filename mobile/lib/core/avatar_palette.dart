import 'package:flutter/painting.dart';

// Keep the native palette aligned with shared/avatar-palette.json. The contract
// test compares these values; no asset decoding or stored profile edits are needed.
const defaultAvatarColor = '#1084FE';
const avatarColors = [
  '#1084FE',
  '#FF263C',
  '#00BCA6',
  '#FF6700',
  '#FF9800',
  '#FF309B',
];
const avatarRoleColors = {
  'orb': '#1084FE',
  'drop': '#FF263C',
  'leaf': '#00BCA6',
  'spark': '#FF9800',
  'gem': '#FF309B',
  'arch': '#FF6700',
};
const legacyAvatarColors = {
  '#3f7f64': '#1084FE',
  '#4d7f9a': '#FF263C',
  '#879348': '#00BCA6',
  '#c27c50': '#FF6700',
  '#c39a43': '#FF9800',
  '#b86f74': '#FF309B',
  '#9363ed': '#1084FE',
  '#8a61ee': '#1084FE',
  '#8b5cf6': '#1084FE',
  '#76568d': '#1084FE',
  '#3294f9': '#FF263C',
  '#4088f3': '#FF263C',
  '#0ac987': '#00BCA6',
  '#24b78c': '#00BCA6',
  '#ff871f': '#FF6700',
  '#fb8742': '#FF6700',
  '#f5b52e': '#FF9800',
  '#e9ae38': '#FF9800',
  '#e65e91': '#FF309B',
  '#ed7299': '#FF309B',
};
const avatarPurpleRange = {
  'minHue': 245,
  'maxHue': 315,
  'minSaturation': .18,
  'minBrightness': .25,
};

/// Derive vector fills without changing profiles, themes or uploaded photos.
String displayAvatarColor(
  Object? value, {
  String fallback = defaultAvatarColor,
}) {
  if (value is! String || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
    return fallback;
  }
  final legacy = legacyAvatarColors[value.toLowerCase()];
  if (legacy != null) return legacy;
  final hsv = HSVColor.fromColor(avatarColorValue(value));
  if (hsv.value >= avatarPurpleRange['minBrightness']! &&
      hsv.saturation >= avatarPurpleRange['minSaturation']! &&
      hsv.hue >= avatarPurpleRange['minHue']! &&
      hsv.hue <= avatarPurpleRange['maxHue']!) {
    return defaultAvatarColor;
  }
  return value;
}

Color avatarColorValue(String hex) =>
    Color(int.parse(hex.substring(1), radix: 16) | 0xff000000);

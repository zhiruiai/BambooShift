import 'package:flutter/painting.dart';

// Keep the native palette aligned with shared/avatar-palette.json. The contract
// test compares these values; no asset decoding or stored profile edits are needed.
const defaultAvatarColor = '#3F7F64';
const avatarColors = [
  '#3F7F64',
  '#4D7F9A',
  '#879348',
  '#C27C50',
  '#C39A43',
  '#B86F74',
];
const avatarRoleColors = {
  'orb': '#3F7F64',
  'drop': '#4D7F9A',
  'leaf': '#879348',
  'spark': '#C39A43',
  'gem': '#B86F74',
  'arch': '#C27C50',
};
const legacyAvatarColors = {
  '#9363ed': '#3F7F64',
  '#8a61ee': '#3F7F64',
  '#8b5cf6': '#3F7F64',
  '#76568d': '#3F7F64',
  '#3294f9': '#4D7F9A',
  '#4088f3': '#4D7F9A',
  '#0ac987': '#879348',
  '#24b78c': '#879348',
  '#ff871f': '#C27C50',
  '#fb8742': '#C27C50',
  '#f5b52e': '#C39A43',
  '#e9ae38': '#C39A43',
  '#e65e91': '#B86F74',
  '#ed7299': '#B86F74',
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

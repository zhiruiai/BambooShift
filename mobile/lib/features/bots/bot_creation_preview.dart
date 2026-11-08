import '../../core/api.dart';

const _textLimits = {
  'name': 40,
  'role': 80,
  'description': 1000,
  'instructions': 16000,
};
const _shapes = {'orb', 'drop', 'leaf', 'spark', 'gem', 'arch'};
final _color = RegExp(r'^#[0-9a-fA-F]{6}$');

Json? botCreationPreview(Object? value) {
  if (value is! Json || value.length != 2 || value['kind'] != 'bot') {
    return null;
  }
  final profile = value['profile'];
  if (profile is! Json ||
      profile.length != 7 ||
      !profile.containsKey('avatarImageId') ||
      profile['avatarImageId'] != null ||
      !_shapes.contains(profile['avatar'])) {
    return null;
  }
  final color = profile['color'];
  if (color is! String || color.length != 7 || !_color.hasMatch(color)) {
    return null;
  }
  final result = <String, dynamic>{};
  for (final entry in _textLimits.entries) {
    final text = profile[entry.key];
    if (text is! String ||
        text.length > entry.value ||
        text.contains('\x00') ||
        ((entry.key == 'name' || entry.key == 'role') && text.trim().isEmpty)) {
      return null;
    }
    result[entry.key] = text.trim();
  }
  return {
    ...result,
    'avatar': profile['avatar'],
    'color': color.toLowerCase(),
    'avatarImageId': null,
  };
}

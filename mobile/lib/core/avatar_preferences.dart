import 'classic_avatar.g.dart';
import 'community_avatar_catalog.g.dart';

const defaultAvatarTheme = classicAvatarTheme;
const originalAvatarThemes = [
  'companions',
  'pandas',
  'dinosaurs',
  'chicks',
  'elephants',
];
const avatarThemes = [
  defaultAvatarTheme,
  ...originalAvatarThemes,
  ...communityAvatarThemes,
];

String validAvatarTheme(Object? value) =>
    value is String && avatarThemes.contains(value)
    ? value
    : defaultAvatarTheme;

class GeneratedAvatarTheme {
  GeneratedAvatarTheme._(
    this.name,
    this.motif,
    this.colors,
    this.badge,
    this.backdrop,
  );

  final String name, motif, badge, backdrop;
  final List<String> colors;

  static GeneratedAvatarTheme? parse(Object? value) {
    if (value is! Map<String, dynamic> || value.length != 5) return null;
    final name = value['name'],
        motif = value['motif'],
        colors = value['colors'];
    final badge = value['badge'], backdrop = value['backdrop'];
    final letters = RegExp(r'[\p{L}\p{N}]', unicode: true);
    if (name is! String ||
        name.trim().isEmpty ||
        name.length > 40 ||
        !letters.hasMatch(name) ||
        !RegExp(r"^[\p{L}\p{N} '’·-]+$", unicode: true).hasMatch(name) ||
        !avatarThemes.contains(motif) ||
        badge is! String ||
        !['none', 'star', 'flower', 'moon', 'bolt'].contains(badge) ||
        backdrop is! String ||
        !['plain', 'halo', 'solid'].contains(backdrop) ||
        colors is! List ||
        colors.length != 3 ||
        !colors.every(
          (v) => v is String && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(v),
        )) {
      return null;
    }
    final palette = colors.cast<String>().map((v) => v.toLowerCase()).toList();
    if (palette.toSet().length != 3) return null;
    return GeneratedAvatarTheme._(
      name.trim(),
      motif as String,
      List.unmodifiable(palette),
      badge,
      backdrop,
    );
  }

  static GeneratedAvatarTheme? preview(Object? value) =>
      value is Map<String, dynamic> &&
          value.length == 2 &&
          value['kind'] == 'theme'
      ? parse(value['theme'])
      : null;

  String colorFor(String shape) => switch (shape) {
    'drop' || 'gem' => colors[1],
    'leaf' || 'arch' => colors[2],
    _ => colors[0],
  };

  Map<String, dynamic> toJson() => {
    'name': name,
    'motif': motif,
    'colors': colors,
    'badge': badge,
    'backdrop': backdrop,
  };
}

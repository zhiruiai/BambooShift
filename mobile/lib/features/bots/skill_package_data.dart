import 'dart:convert';

import '../../core/api.dart';

const skillPackageMaxFiles = 64;
const skillPackageMaxFileBytes = 256 * 1024;
const skillPackageMaxBytes = 1024 * 1024;
const skillPackageMaxContentBytes = 64 * 1024;
final _control = RegExp(r'[\x00-\x1f\x7f-\x9f]');
final _name = RegExp(
  r'^[\p{Alphabetic}\p{N}]+(?:-[\p{Alphabetic}\p{N}]+)*$',
  unicode: true,
);
final _digest = RegExp(r'^[a-f0-9]{64}$');

bool validSkillPackageName(String name) =>
    name == name.toLowerCase() &&
    name == name.trim() &&
    name.runes.length <= 64 &&
    _name.hasMatch(name);

bool validSkillPackagePath(String path) =>
    path.isNotEmpty &&
    utf8.encode(path).length <= 320 &&
    !path.contains(RegExp(r'[:\\]')) &&
    !_control.hasMatch(path) &&
    path
        .split('/')
        .every(
          (part) =>
              part.isNotEmpty && !part.endsWith('.') && !part.endsWith(' '),
        );

bool bundledSkill(Json skill) =>
    skill['skillPackage'] != null &&
    skill['skillPackageSource'] != 'workspace-text';

typedef SkillPackageFile = ({String path, int? size, String? sha256});

class SkillPackageDetails {
  const SkillPackageDetails(this.root, this.frontmatter, this.files);

  final String root;
  final Json frontmatter;
  final List<SkillPackageFile> files;

  String get fingerprint => jsonEncode([
    root,
    for (final file in files) [file.path, file.size, file.sha256],
  ]);

  static SkillPackageDetails? installed(Json skill) {
    final manifest = skill['skillPackage'];
    if (manifest is! Json || manifest['format'] != 'agent-skills') return null;
    final root = manifest['root'], fields = manifest['frontmatter'];
    final rows = manifest['files'];
    if (root is! String ||
        !validSkillPackageName(root) ||
        (bundledSkill(skill) && root != skill['name']) ||
        fields is! Json ||
        fields['name'] != root ||
        rows is! List ||
        rows.isEmpty ||
        rows.length > skillPackageMaxFiles) {
      return null;
    }
    final files = <SkillPackageFile>[];
    final paths = <String>{};
    var total = 0;
    for (final row in rows) {
      if (row
          case {
            'path': final String path,
            'size': final int size,
            'sha256': final String hash,
          }
          when validSkillPackagePath(path) &&
              size >= 0 &&
              size <= skillPackageMaxFileBytes &&
              _digest.hasMatch(hash) &&
              paths.add(path.toLowerCase())) {
        total += size;
        files.add((path: path, size: size, sha256: hash));
      } else {
        return null;
      }
    }
    if (total > skillPackageMaxBytes ||
        !files.any((file) => file.path == 'SKILL.md')) {
      return null;
    }
    return SkillPackageDetails(
      root,
      fields,
      files..sort((a, b) => a.path.compareTo(b.path)),
    );
  }

  static SkillPackageDetails draft(Json package) => SkillPackageDetails(
    package['root'] as String,
    package['frontmatter'] as Json,
    [
      (path: 'SKILL.md', size: null, sha256: null),
      for (final file in (package['files'] as List).cast<Json>())
        (path: file['path'] as String, size: null, sha256: null),
    ],
  );
}

String skillDisplayName(Json skill) {
  final package = skill['skillPackage'];
  final frontmatter = package is Json ? package['frontmatter'] : null;
  final metadata = frontmatter is Json ? frontmatter['metadata'] : null;
  final title = metadata is Json ? metadata['title'] : null;
  if (title is String &&
      title.trim().isNotEmpty &&
      title.length <= 160 &&
      !_control.hasMatch(title)) {
    return title.trim();
  }
  final name = skill['name'];
  return name is String ? name : '';
}

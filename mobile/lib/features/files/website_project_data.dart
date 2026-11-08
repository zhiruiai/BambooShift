import 'dart:convert';
import 'dart:typed_data';

import '../../core/api.dart';

const websiteMaxBytes = 10 * 1024 * 1024;
const websiteMaxFileBytes = 4 * 1024 * 1024;
const websiteMaxFiles = 64;
final _digest = RegExp(r'^[0-9a-f]{64}$');
final _pathPart = RegExp(r'^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,79}$');
const _websiteMimes = {
  'text/html',
  'text/css',
  'text/javascript',
  'text/plain',
  'text/csv',
  'application/json',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'font/woff',
  'font/woff2',
};

bool _validPath(String path) {
  final parts = path.split('/');
  return path.length <= 240 &&
      parts.length <= 12 &&
      parts.every((part) => _pathPart.hasMatch(part) && !part.endsWith('.'));
}

typedef WebsiteProject = ({
  String id,
  String projectKey,
  String title,
  String entry,
  int fileCount,
  int totalBytes,
});

WebsiteProject? _summary(Object? value) {
  if (value
      case {
        'id': final String id,
        'projectKey': final String projectKey,
        'title': final String title,
        'entry': final String entry,
        'fileCount': final int fileCount,
        'totalBytes': final int totalBytes,
      }
      when _digest.hasMatch(id) &&
          _digest.hasMatch(projectKey) &&
          title.trim().isNotEmpty &&
          title.length <= 100 &&
          _validPath(entry) &&
          RegExp(r'\.html?$', caseSensitive: false).hasMatch(entry) &&
          fileCount >= 1 &&
          fileCount <= websiteMaxFiles &&
          totalBytes >= 0 &&
          totalBytes <= websiteMaxBytes) {
    return (
      id: id,
      projectKey: projectKey,
      title: title,
      entry: entry,
      fileCount: fileCount,
      totalBytes: totalBytes,
    );
  }
  return null;
}

WebsiteProject? websiteProjectFor(Json message) {
  if (message case {
    'kind': 'website_project',
    'role': 'assistant',
    'metadata': {'websiteProject': final Object? project},
  }) {
    return _summary(project);
  }
  return null;
}

typedef WebsiteAsset = ({String path, String mime, String sha256, int size});

class WebsiteProjectFile {
  const WebsiteProjectFile(this.asset, this.bytes);
  final WebsiteAsset asset;
  final Uint8List bytes;

  String? get source {
    final mime = asset.mime;
    if (!mime.startsWith('text/') &&
        mime != 'application/json' &&
        mime != 'image/svg+xml') {
      return null;
    }
    try {
      return utf8.decode(bytes);
    } on FormatException {
      return null;
    }
  }
}

List<WebsiteAsset> websiteProjectManifest(
  WebsiteProject project,
  Object? value,
) {
  if (_summary(value) != project ||
      value is! Json ||
      value['files'] is! List ||
      (value['files'] as List).length != project.fileCount) {
    throw const FormatException('Invalid website project manifest');
  }
  final seen = <String>{};
  final files = <WebsiteAsset>[];
  var total = 0;
  for (final row in value['files'] as List) {
    if (row
        case {
          'path': final String path,
          'mime': final String mime,
          'sha256': final String sha256,
          'size': final int size,
        }
        when _validPath(path) &&
            _websiteMimes.contains(mime) &&
            _digest.hasMatch(sha256) &&
            size >= 0 &&
            size <= websiteMaxFileBytes &&
            seen.add(path.toLowerCase())) {
      files.add((path: path, mime: mime, sha256: sha256, size: size));
      total += size;
    } else {
      throw const FormatException('Invalid website project asset');
    }
  }
  if (total != project.totalBytes ||
      !files.any(
        (file) => file.path == project.entry && file.mime == 'text/html',
      )) {
    throw const FormatException('Invalid website project asset list');
  }
  return List.unmodifiable(files);
}

List<Json> latestWebsiteProjects(Iterable<Json> messages) {
  final seen = <String>{};
  final latest = <Json>[];
  for (final message in messages.toList().reversed) {
    final project = websiteProjectFor(message);
    if (project != null && seen.add(project.projectKey)) latest.add(message);
  }
  return latest;
}

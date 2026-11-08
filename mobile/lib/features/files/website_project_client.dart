import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../../core/api.dart';
import '../../core/binary_transport.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import 'website_project_data.dart';

class WebsiteProjectClient {
  WebsiteProjectClient(this.scope, this.message)
    : project = websiteProjectFor(message)!;
  final WorkspaceController scope;
  final Json message;
  final WebsiteProject project;

  bool get active {
    if (!scope.active || message['id'] is! String) return false;
    final current = scope.find('messages', message['id'] as String);
    final conversationId = message['conversationId'];
    return current != null &&
        conversationId is String &&
        scope.find('conversations', conversationId) != null &&
        current['conversationId'] == conversationId &&
        websiteProjectFor(current) == project;
  }

  Future<BinaryReadResult> _read(
    String suffix,
    String mime,
    int maximum,
    ByteReadCancellation cancellation,
  ) {
    final workspace = RegExp(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$');
    if (!workspace.hasMatch(scope.workspaceId)) {
      throw const ApiException('INVALID_PATH', 'mobileWebsiteUnavailable');
    }
    return readBoundedBinary(
      scope.session.api,
      scope.path('/website-projects/${project.id}$suffix'),
      expectedUser: scope.userId,
      isCurrent: () => active,
      cancellation: cancellation,
      maximum: maximum,
      timeout: const Duration(seconds: 30),
      accept: mime,
      unavailable: 'mobileWebsiteUnavailable',
      failed: 'mobileWebsiteLoadFailed',
      tooLarge: 'mobileWebsiteLoadFailed',
      validateHeaders: (headers) {
        final contentType = headers['content-type']?.split(';').first.trim();
        final disposition = headers['content-disposition'] ?? '';
        if (contentType != mime ||
            (mime != 'application/json' &&
                !RegExp(
                  r'^attachment(?:;|$)',
                  caseSensitive: false,
                ).hasMatch(disposition))) {
          throw const ApiException(
            'INVALID_PROJECT',
            'mobileWebsiteLoadFailed',
          );
        }
      },
    );
  }

  Future<List<WebsiteProjectFile>> load(
    ByteReadCancellation cancellation,
  ) async {
    try {
      final manifest = await _read(
        '',
        'application/json',
        64 * 1024,
        cancellation,
      );
      final assets = websiteProjectManifest(
        project,
        jsonDecode(utf8.decode(manifest.bytes)),
      );
      final files = <WebsiteProjectFile>[];
      for (var start = 0; start < assets.length; start += 4) {
        final batch = await Future.wait(
          assets.skip(start).take(4).map((asset) async {
            final result = await _read(
              '/files/${asset.path}',
              'application/octet-stream',
              asset.size,
              cancellation,
            );
            if (result.bytes.length != asset.size ||
                sha256.convert(result.bytes).toString() != asset.sha256) {
              throw const FormatException('Website project checksum mismatch');
            }
            return WebsiteProjectFile(asset, result.bytes);
          }),
          eagerError: true,
        );
        files.addAll(batch);
      }
      return List.unmodifiable(files);
    } catch (_) {
      cancellation.cancel();
      rethrow;
    }
  }

  String get archiveName => 'website-${project.id.substring(0, 12)}.zip';

  Future<FileBytes> download(ByteReadCancellation cancellation) async {
    final result = await _read(
      '/download',
      'application/zip',
      project.totalBytes + 128 * 1024,
      cancellation,
    );
    final bytes = result.bytes;
    if (bytes.length < 4 ||
        bytes[0] != 0x50 ||
        bytes[1] != 0x4b ||
        bytes[2] != 3 ||
        bytes[3] != 4) {
      throw const FormatException('Invalid website project ZIP');
    }
    return FileBytes(bytes, 'application/zip');
  }

  Future<void> authorize(ByteReadCancellation cancellation) async {
    final result = await _read('', 'application/json', 64 * 1024, cancellation);
    websiteProjectManifest(project, jsonDecode(utf8.decode(result.bytes)));
  }
}

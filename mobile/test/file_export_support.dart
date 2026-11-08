import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui';

import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/features/files/file_export_cache.dart';
import 'package:openbot_mobile/features/files/file_export_controller.dart';
import 'package:openbot_mobile/features/files/file_export_platform.dart';

import 'support.dart';

class ExportServer {
  ExportServer({
    List<int>? content,
    this.name = 'report.pdf',
    this.mimeType = 'application/pdf',
  }) : content = Uint8List.fromList(content ?? utf8.encode('%PDF synthetic'));
  final Uint8List content;
  final String name, mimeType;
  final requests = <http.Request>[];
  bool missing = false, failRead = false, wrongSize = false;
  String? conversationId = 'chat-a';
  Completer<http.Response>? download;
  Json get file => {
    'id': 'file-a',
    'name': name,
    'size': content.length,
    'type': mimeType,
    'createdAt': '2026-11-07T00:00:00Z',
    'conversationId': ?conversationId,
  };
  Json get data => {
    ...bootstrap(),
    'files': missing ? <Json>[] : [file],
  };
  Future<http.Response> handle(http.Request request) async {
    requests.add(request);
    if (request.url.path.endsWith('/bootstrap')) {
      return failRead
          ? jsonResponse({'error': 'Unavailable'}, status: 503)
          : jsonResponse(data);
    }
    if (request.url.path.endsWith('/files/file-a/download')) {
      if (download != null) return download!.future;
      return bytes();
    }
    return jsonResponse({'error': 'Unexpected path'}, status: 404);
  }

  http.Response bytes() => http.Response.bytes(
    wrongSize ? [...content, 65] : content,
    200,
    headers: {
      'content-type': mimeType,
      'content-disposition': 'attachment; filename="$name"',
    },
  );
}

class ExportDestination implements FileExportDestination {
  @override
  bool supported = true;
  int calls = 0;
  FileBytes? received;
  Future<void> Function()? beforeHandoff;
  FileExportResult result = FileExportResult.selected;
  @override
  Future<FileExportResult> export(
    FileBytes data,
    String name,
    Rect origin, {
    required Future<void> Function() authorize,
    required void Function() guard,
  }) async {
    await beforeHandoff?.call();
    await authorize();
    guard();
    calls++;
    received = data;
    return result;
  }
}

class ExportSystem implements FileExportSystem {
  ExportSystem(this.directory, {this.usesShareSheet = true});
  final Directory directory;
  @override
  bool supported = true;
  @override
  final bool usesShareSheet;
  String? path;
  Future<void> Function()? beforeChoice;
  Future<void> Function(StagedFileExport)? onShare;
  final events = <String>[];
  StagedFileExport? staged;
  String? pickedName, savedPath;
  FileExportResult result = FileExportResult.selected;
  @override
  Future<Directory> temporaryDirectory() async => directory;
  @override
  Directory? pluginCopies(Directory directory) =>
      Directory('${directory.path}/share_plus');
  @override
  Future<String?> chooseSavePath(String name) async {
    pickedName = name;
    events.add('picker');
    await beforeChoice?.call();
    return path;
  }

  @override
  Future<void> save(FileBytes bytes, String name, String path) async {
    events.add('save');
    savedPath = path;
  }

  @override
  Future<FileExportResult> share(
    StagedFileExport staged,
    String mimeType,
    Rect origin,
  ) async {
    events.add('share');
    this.staged = staged;
    await onShare?.call(staged);
    return result;
  }
}

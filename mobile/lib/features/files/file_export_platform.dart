import 'dart:io';
import 'dart:ui';

import 'package:file_selector/file_selector.dart' as selector;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import 'file_export_cache.dart';
import 'file_export_controller.dart';

Rect? fileShareOrigin(Rect requested, Size viewport) {
  if (!requested.isFinite || !viewport.isFinite || viewport.isEmpty) {
    return null;
  }
  final clipped = requested.intersect(Offset.zero & viewport);
  return clipped.isEmpty ? null : clipped;
}

abstract interface class FileExportSystem {
  bool get supported;
  bool get usesShareSheet;
  Future<Directory> temporaryDirectory();
  Directory? pluginCopies(Directory directory);
  Future<String?> chooseSavePath(String name);
  Future<void> save(FileBytes bytes, String name, String path);
  Future<FileExportResult> share(
    StagedFileExport staged,
    String mimeType,
    Rect origin,
  );
}

class DeviceFileExportSystem implements FileExportSystem {
  @override
  bool get supported =>
      Platform.isAndroid ||
      Platform.isIOS ||
      Platform.isMacOS ||
      Platform.isWindows ||
      Platform.isLinux;
  @override
  bool get usesShareSheet => Platform.isAndroid || Platform.isIOS;
  @override
  Future<Directory> temporaryDirectory() => getTemporaryDirectory();
  @override
  Directory? pluginCopies(Directory directory) =>
      Platform.isAndroid ? Directory('${directory.path}/share_plus') : null;
  @override
  Future<String?> chooseSavePath(String name) async =>
      (await selector.getSaveLocation(suggestedName: name))?.path;
  @override
  Future<void> save(FileBytes bytes, String name, String path) =>
      selector.XFile.fromData(
        bytes.bytes,
        mimeType: bytes.mimeType,
        name: name,
      ).saveTo(path);
  @override
  Future<FileExportResult> share(
    StagedFileExport staged,
    String mimeType,
    Rect origin,
  ) async {
    final view = PlatformDispatcher.instance.implicitView;
    final result = await SharePlus.instance.share(
      ShareParams(
        files: [XFile(staged.file.path, mimeType: mimeType)],
        sharePositionOrigin: view == null
            ? null
            : fileShareOrigin(
                origin,
                view.physicalSize / view.devicePixelRatio,
              ),
        downloadFallbackEnabled: false,
        mailToFallbackEnabled: false,
      ),
    );
    return switch (result.status) {
      ShareResultStatus.success => FileExportResult.selected,
      ShareResultStatus.dismissed => FileExportResult.dismissed,
      ShareResultStatus.unavailable => FileExportResult.unknown,
    };
  }
}

class NativeFileExport implements FileExportDestination {
  NativeFileExport({FileExportSystem? system})
    : system = system ?? DeviceFileExportSystem();
  static bool _sharing = false;
  final FileExportSystem system;
  @override
  bool get supported => system.supported;

  @override
  Future<FileExportResult> export(
    FileBytes bytes,
    String name,
    Rect origin, {
    required Future<void> Function() authorize,
    required void Function() guard,
  }) async {
    if (!supported) {
      throw const ApiException(
        'EXPORT_UNAVAILABLE',
        'mobileFilesExportUnavailable',
      );
    }
    if (_sharing) {
      throw const ApiException('EXPORT_BUSY', 'mobileFilesExportBusy');
    }
    _sharing = true;
    StagedFileExport? staged;
    var handedOff = false;
    try {
      if (!system.usesShareSheet) {
        guard();
        final location = await system.chooseSavePath(exportBasename(name));
        await authorize();
        if (location == null) return FileExportResult.dismissed;
        guard();
        await system.save(bytes, exportBasename(name), location);
        guard();
        return FileExportResult.saved;
      }
      final directory = await system.temporaryDirectory();
      guard();
      final cache = FileExportCache(
        directory,
        pluginDirectory: system.pluginCopies(directory),
      );
      staged = await cache.stage(bytes, name, guard);
      await authorize();
      guard();
      // Once handed to the OS, copies are retained until their bounded cache expiry.
      handedOff = true;
      final result = await system.share(staged, bytes.mimeType, origin);
      guard();
      return result;
    } finally {
      if (!handedOff) await staged?.discard();
      _sharing = false;
    }
  }
}

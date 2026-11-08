import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../core/byte_read.dart';
import '../../core/request_ids.dart';

final _ownedFile = RegExp(r'^openbot-export-([0-9]{13})-([0-9a-f-]{36})_');
final _ownedDirectory = RegExp(
  r'^openbot-export-([0-9]{13})-[0-9a-f-]{36}-[A-Za-z0-9]+$',
);
String exportBasename(String name) {
  var base = name.split(RegExp(r'[/\\]')).last;
  base = base.replaceAll(RegExp(r'[\x00-\x1f\x7f<>:"|?*]'), '_');
  if (base.isEmpty || base == '.' || base == '..') base = 'file';
  final dot = base.lastIndexOf('.');
  final extension = dot > 0 && base.length - dot <= 20
      ? base.substring(dot)
      : '';
  var stem = extension.isEmpty ? base : base.substring(0, dot);
  while (utf8.encode(stem + extension).length > 150) {
    final runes = stem.runes.toList();
    stem = String.fromCharCodes(runes.take(runes.length - 1));
  }
  return '$stem$extension';
}

class FileExportCache {
  FileExportCache(
    this.directory, {
    this.pluginDirectory,
    this.ttl = const Duration(minutes: 5),
    DateTime Function()? clock,
  }) : clock = clock ?? DateTime.now;
  final Directory directory;
  final Directory? pluginDirectory;
  final Duration ttl;
  final DateTime Function() clock;

  Future<StagedFileExport> stage(
    FileBytes bytes,
    String name,
    void Function() guard,
  ) async {
    guard();
    await prune();
    guard();
    final id = requestId(), at = clock().millisecondsSinceEpoch;
    final prefix = 'openbot-export-$at-$id';
    final folder = await directory.createTemp('$prefix-');
    final file = File('${folder.path}/${prefix}_${exportBasename(name)}');
    final staged = StagedFileExport(
      folder,
      file,
      pluginDirectory == null
          ? null
          : File('${pluginDirectory!.path}/${file.uri.pathSegments.last}'),
    );
    try {
      guard();
      await file.writeAsBytes(bytes.bytes, flush: true);
      guard();
      staged.timer = Timer(ttl, () => unawaited(staged.discard()));
      return staged;
    } catch (_) {
      await staged.discard();
      rethrow;
    }
  }

  Future<void> prune() async {
    final threshold = clock().subtract(ttl).millisecondsSinceEpoch;
    await for (final entry in directory.list(followLinks: false)) {
      final name = entry.uri.pathSegments.where((s) => s.isNotEmpty).last;
      final match = _ownedDirectory.firstMatch(name);
      if (match == null ||
          int.parse(match[1]!) > threshold ||
          await FileSystemEntity.type(entry.path, followLinks: false) !=
              FileSystemEntityType.directory) {
        continue;
      }
      final folder = Directory(entry.path);
      await for (final child in folder.list(followLinks: false)) {
        final fileName = child.uri.pathSegments.last;
        if (_ownedFile.hasMatch(fileName) &&
            await FileSystemEntity.type(child.path, followLinks: false) ==
                FileSystemEntityType.file) {
          await _remove(File(child.path));
        }
      }
      try {
        await folder.delete();
      } on FileSystemException {
        /* Keep unrelated entries. */
      }
    }
    final plugin = pluginDirectory;
    if (plugin == null ||
        await FileSystemEntity.type(plugin.path, followLinks: false) !=
            FileSystemEntityType.directory) {
      return;
    }
    await for (final entry in plugin.list(followLinks: false)) {
      final match = _ownedFile.firstMatch(entry.uri.pathSegments.last);
      if (match != null &&
          int.parse(match[1]!) <= threshold &&
          await FileSystemEntity.type(entry.path, followLinks: false) ==
              FileSystemEntityType.file) {
        await _remove(File(entry.path));
      }
    }
  }
}

Future<void> _remove(File file) async {
  try {
    if (await FileSystemEntity.type(file.path, followLinks: false) ==
        FileSystemEntityType.file) {
      await file.delete();
    }
  } on FileSystemException {
    /* Retry owned expired files at the next export. */
  }
}

class StagedFileExport {
  StagedFileExport(this.directory, this.file, this.pluginFile);
  final Directory directory;
  final File file;
  final File? pluginFile;
  Timer? timer;
  Future<void> discard() async {
    timer?.cancel();
    await _remove(file);
    if (pluginFile != null) await _remove(pluginFile!);
    try {
      await directory.delete();
    } on FileSystemException {
      /* A stale shell is safe to retry. */
    }
  }
}

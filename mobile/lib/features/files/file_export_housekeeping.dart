import 'dart:async';

import 'package:flutter/widgets.dart';

import 'file_export_cache.dart';
import 'file_export_platform.dart';

class FileExportHousekeeping with WidgetsBindingObserver {
  FileExportHousekeeping({Future<FileExportCache?> Function()? cache})
    : _cache = cache ?? _deviceCache;
  final Future<FileExportCache?> Function() _cache;
  bool _started = false, _running = false, _closed = false;

  static Future<FileExportCache?> _deviceCache() async {
    final system = DeviceFileExportSystem();
    if (!system.supported || !system.usesShareSheet) return null;
    final directory = await system.temporaryDirectory();
    return FileExportCache(
      directory,
      pluginDirectory: system.pluginCopies(directory),
    );
  }

  void start() {
    if (_closed || _started) return;
    _started = true;
    WidgetsBinding.instance.addObserver(this);
    unawaited(prune());
  }

  Future<void> prune() async {
    if (_running || _closed) return;
    _running = true;
    try {
      final cache = await _cache();
      if (!_closed) await cache?.prune();
    } catch (_) {
      // A missing platform cache is retried on resume or the next explicit export.
    } finally {
      _running = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(prune());
  }

  void dispose() {
    _closed = true;
    if (_started) WidgetsBinding.instance.removeObserver(this);
  }
}

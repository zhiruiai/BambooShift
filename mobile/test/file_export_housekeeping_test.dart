import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/files/file_export_cache.dart';
import 'package:openbot_mobile/features/files/file_export_housekeeping.dart';

class CountingCache extends FileExportCache {
  CountingCache() : super(Directory('/unused-private-cache'));
  int calls = 0;
  @override
  Future<void> prune() async {
    calls++;
  }
}

void main() {
  testWidgets(
    'housekeeping prunes on startup and resume, without an export or network request',
    (tester) async {
      final cache = CountingCache();
      final housekeeping = FileExportHousekeeping(cache: () async => cache);
      housekeeping.start();
      housekeeping.start();
      await tester.pump();
      expect(cache.calls, 1);
      housekeeping.didChangeAppLifecycleState(AppLifecycleState.paused);
      await tester.pump();
      expect(cache.calls, 1);
      housekeeping.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await tester.pump();
      expect(cache.calls, 2);
      housekeeping.dispose();
      housekeeping.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await tester.pump();
      expect(cache.calls, 2);
    },
  );
  test(
    'cache discovery failures do not leak device paths or disable the next cleanup',
    () async {
      var calls = 0;
      final cache = CountingCache();
      final housekeeping = FileExportHousekeeping(
        cache: () async {
          calls++;
          if (calls == 1) {
            throw FileSystemException('Synthetic discovery failure');
          }
          return cache;
        },
      );
      await housekeeping.prune();
      await housekeeping.prune();
      expect(calls, 2);
      expect(cache.calls, 1);
      housekeeping.dispose();
    },
  );
  test(
    'concurrent resume signals share one cache read and closed apps discard late discovery',
    () async {
      final gate = Completer<FileExportCache?>();
      var reads = 0;
      final cache = CountingCache();
      final housekeeping = FileExportHousekeeping(
        cache: () {
          reads++;
          return gate.future;
        },
      );
      final first = housekeeping.prune();
      await housekeeping.prune();
      housekeeping.dispose();
      gate.complete(cache);
      await first;
      expect(reads, 1);
      expect(cache.calls, 0);
    },
  );
}

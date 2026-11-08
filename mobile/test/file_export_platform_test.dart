import 'dart:io';
import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/features/files/file_export_cache.dart';
import 'package:openbot_mobile/features/files/file_export_controller.dart';
import 'package:openbot_mobile/features/files/file_export_platform.dart';

import 'file_export_support.dart';

final bytes = FileBytes(
  Uint8List.fromList([37, 80, 68, 70]),
  'application/pdf',
);
const origin = Rect.fromLTWH(10, 10, 40, 40);

void main() {
  test(
    'share popovers clip to the current viewport after rotation or scrolling',
    () {
      expect(
        fileShareOrigin(
          const Rect.fromLTWH(10, 10, 40, 40),
          const Size(390, 844),
        ),
        const Rect.fromLTWH(10, 10, 40, 40),
      );
      expect(
        fileShareOrigin(
          const Rect.fromLTWH(380, 10, 40, 40),
          const Size(390, 844),
        ),
        const Rect.fromLTWH(380, 10, 10, 40),
      );
      expect(
        fileShareOrigin(
          const Rect.fromLTWH(10, 700, 40, 40),
          const Size(844, 390),
        ),
        isNull,
      );
    },
  );
  test(
    'desktop save picker is explicit and reauthorizes before writing the chosen destination',
    () async {
      final dir = await Directory.systemTemp.createTemp('openbot-export-test-');
      addTearDown(() => dir.delete(recursive: true));
      final system = ExportSystem(dir, usesShareSheet: false)
        ..path = '${dir.path}/chosen.pdf';
      final native = NativeFileExport(system: system);
      expect(system.events, isEmpty);
      final result = await native.export(
        bytes,
        '../report.pdf',
        origin,
        authorize: () async {
          system.events.add('authorize');
        },
        guard: () {},
      );
      expect(result, FileExportResult.saved);
      expect(system.pickedName, 'report.pdf');
      expect(system.savedPath, system.path);
      expect(system.events, ['picker', 'authorize', 'save']);
      expect(system.staged, isNull);
    },
  );
  test('desktop cancellation never writes or creates cached copies', () async {
    final dir = await Directory.systemTemp.createTemp('openbot-export-test-');
    addTearDown(() => dir.delete(recursive: true));
    final system = ExportSystem(dir, usesShareSheet: false);
    final result = await NativeFileExport(
      system: system,
    ).export(bytes, 'report.pdf', origin, authorize: () async {}, guard: () {});
    expect(result, FileExportResult.dismissed);
    expect(system.savedPath, isNull);
    expect(await dir.list().toList(), isEmpty);
  });
  test('scope lost while desktop picker is open prevents any save', () async {
    final dir = await Directory.systemTemp.createTemp('openbot-export-test-');
    addTearDown(() => dir.delete(recursive: true));
    var active = true;
    final system = ExportSystem(dir, usesShareSheet: false)
      ..path = '${dir.path}/chosen.pdf'
      ..beforeChoice = () async {
        active = false;
      };
    void guard() {
      if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }

    await expectLater(
      NativeFileExport(system: system).export(
        bytes,
        'report.pdf',
        origin,
        authorize: () async {
          guard();
        },
        guard: guard,
      ),
      throwsA(isA<ApiException>()),
    );
    expect(system.savedPath, isNull);
  });
  test(
    'mobile sheet retains its private copy after selection until bounded expiry',
    () async {
      final dir = await Directory.systemTemp.createTemp('openbot-export-test-');
      addTearDown(() => dir.delete(recursive: true));
      final system = ExportSystem(dir);
      final result = await NativeFileExport(system: system).export(
        bytes,
        'report.pdf',
        origin,
        authorize: () async {
          system.events.add('authorize');
        },
        guard: () {},
      );
      expect(result, FileExportResult.selected);
      expect(system.events, ['authorize', 'share']);
      final staged = system.staged!;
      expect(await staged.file.readAsBytes(), bytes.bytes);
      expect(staged.file.path, endsWith('_report.pdf'));
      await staged.pluginFile!.parent.create();
      await staged.pluginFile!.writeAsBytes(bytes.bytes);
      expect(await staged.pluginFile!.exists(), true);
      await staged.discard();
      expect(await staged.file.exists(), false);
      expect(await staged.pluginFile!.exists(), false);
    },
  );
  test('failure before a mobile handoff discards all staged bytes', () async {
    final dir = await Directory.systemTemp.createTemp('openbot-export-test-');
    addTearDown(() => dir.delete(recursive: true));
    final system = ExportSystem(dir);
    await expectLater(
      NativeFileExport(system: system).export(
        bytes,
        'report.pdf',
        origin,
        authorize: () async {
          throw const ApiException('STALE_SCOPE', 'scopeChanged');
        },
        guard: () {},
      ),
      throwsA(isA<ApiException>()),
    );
    expect(system.staged, isNull);
    expect(await dir.list().toList(), isEmpty);
  });
  test(
    'unknown mobile handoff keeps copies and never retries a system sheet',
    () async {
      final dir = await Directory.systemTemp.createTemp('openbot-export-test-');
      addTearDown(() => dir.delete(recursive: true));
      final system = ExportSystem(dir)
        ..onShare = (_) async {
          throw StateError('Synthetic system uncertainty');
        };
      await expectLater(
        NativeFileExport(system: system).export(
          bytes,
          'report.pdf',
          origin,
          authorize: () async {},
          guard: () {},
        ),
        throwsStateError,
      );
      expect(system.events.where((e) => e == 'share').length, 1);
      expect(await system.staged!.file.exists(), true);
      await system.staged!.discard();
    },
  );
  test(
    'safe filenames retain original formats and do not expose device paths',
    () {
      expect(exportBasename(r'C:\secret\report.pdf'), 'report.pdf');
      expect(exportBasename('../../report.docx'), 'report.docx');
      expect(exportBasename(''), 'file');
      expect(exportBasename('a\u0000b.pdf'), 'a_b.pdf');
      expect(exportBasename('${'研' * 100}.xlsx').endsWith('.xlsx'), true);
      expect(exportBasename('${'研' * 100}.xlsx').length, lessThan(100));
    },
  );
  test(
    'expiry deletes only OpenBot export copies, keeps recent and unrelated cache entries',
    () async {
      final dir = await Directory.systemTemp.createTemp('openbot-export-test-');
      addTearDown(() => dir.delete(recursive: true));
      final plugin = await Directory('${dir.path}/share_plus').create();
      var clock = DateTime.utc(2026, 11, 7);
      final cache = FileExportCache(
        dir,
        pluginDirectory: plugin,
        clock: () => clock,
      );
      final old = await cache.stage(bytes, 'report.pdf', () {});
      await old.pluginFile!.writeAsBytes(bytes.bytes);
      clock = clock.add(const Duration(minutes: 4));
      final recent = await cache.stage(bytes, 'report.pdf', () {});
      final unrelated = await File(
        '${plugin.path}/other-app.pdf',
      ).writeAsBytes(bytes.bytes);
      final protected = await Directory('${dir.path}/not-ours').create();
      await File('${protected.path}/other.txt').writeAsString('Keep');
      final link = Link(
        '${plugin.path}/openbot-export-0000000000000-00000000-0000-0000-0000-000000000000_link.pdf',
      );
      await link.create(unrelated.path);
      clock = clock.add(const Duration(minutes: 2));
      await cache.prune();
      expect(await old.file.exists(), false);
      expect(await old.pluginFile!.exists(), false);
      expect(await recent.file.exists(), true);
      expect(await unrelated.exists(), true);
      expect(await protected.exists(), true);
      expect(await link.exists(), true);
      await old.discard();
      await recent.discard();
    },
  );
  test(
    'scope changes during cache writes remove partial private files',
    () async {
      final dir = await Directory.systemTemp.createTemp('openbot-export-test-');
      addTearDown(() => dir.delete(recursive: true));
      var checks = 0;
      await expectLater(
        FileExportCache(dir).stage(bytes, 'report.pdf', () {
          checks++;
          if (checks == 4) {
            throw const ApiException('STALE_SCOPE', 'scopeChanged');
          }
        }),
        throwsA(isA<ApiException>()),
      );
      expect(checks, 4);
      expect(await dir.list().toList(), isEmpty);
    },
  );
}

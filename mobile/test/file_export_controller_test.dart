import 'dart:async';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/chat/file_preview_data.dart';
import 'package:openbot_mobile/features/files/file_export_controller.dart';

import 'file_export_support.dart';
import 'support.dart';

const origin = Rect.fromLTWH(10, 10, 40, 40);

void main() {
  test(
    'workspace file export cannot bypass a conversation association',
    () async {
      final server = ExportServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final destination = ExportDestination();
      final c = FileExportController(
        f.scope,
        null,
        ChatFile('file-a', server.name, server.content.length),
        destination,
      );
      expect(c.canExport, false);
      await c.export(origin);
      expect(server.requests, isEmpty);
      server.conversationId = null;
      f.scope.data = server.data;
      expect(c.canExport, true);
      await c.export(origin);
      expect(c.error, isNull);
      expect(destination.received?.bytes, server.content);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test('PDF, Office and HTML exports preserve original bytes and format', () async {
    const formats = {
      'pdf': 'application/pdf',
      'docx':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xlsx':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'pptx':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'html': 'text/html',
    };
    for (final format in formats.entries) {
      final server = ExportServer(
        name: 'report.${format.key}',
        mimeType: format.value,
        content: [0, 1, 127, 255],
      );
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final destination = ExportDestination();
      final c = FileExportController(
        f.scope,
        'chat-a',
        ChatFile('file-a', server.name, server.content.length),
        destination,
      );
      expect(server.requests, isEmpty);
      await c.export(origin);
      expect(c.error, isNull);
      expect(destination.received?.bytes, server.content);
      expect(destination.received?.mimeType, format.value);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    }
  });
  test(
    'PDF export is explicit, fixed to actor and chat, freshly checked and never starts a model',
    () async {
      final server = ExportServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final destination = ExportDestination();
      final c = FileExportController(
        f.scope,
        'chat-a',
        ChatFile('file-a', 'report.pdf', server.content.length),
        destination,
      );
      expect(c.canExport, true);
      expect(server.requests, isEmpty);
      expect(destination.calls, 0);
      await c.export(origin);
      expect(c.error, isNull);
      expect(c.notice, 'mobileFilesExportSelected');
      expect(destination.received?.bytes, server.content);
      expect(server.requests.map((r) => r.method).toSet(), {'GET'});
      expect(
        server.requests.where((r) => r.url.path.endsWith('/download')).length,
        1,
      );
      for (final r in server.requests) {
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(r.url.host, 'api.example.test');
      }
      expect(server.requests.first.url.path.endsWith('/bootstrap'), true);
      expect(server.requests.last.url.path.endsWith('/bootstrap'), true);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'documents over preview limit retain a bounded download outlet',
    () async {
      final server = ExportServer(content: List.filled(3 * 1024 * 1024, 65));
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final destination = ExportDestination();
      final c = FileExportController(
        f.scope,
        'chat-a',
        ChatFile('file-a', 'report.pdf', server.content.length),
        destination,
      );
      await c.export(origin);
      expect(c.error, isNull);
      expect(destination.received?.bytes.length, 3 * 1024 * 1024);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'a chat mismatch, oversized file or unavailable destination cannot download',
    () async {
      final server = ExportServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      for (final kind in ['chat', 'size', 'unsupported']) {
        final destination = ExportDestination()
          ..supported = kind != 'unsupported';
        final c = FileExportController(
          f.scope,
          kind == 'chat' ? 'chat-b' : 'chat-a',
          ChatFile(
            'file-a',
            'report.pdf',
            kind == 'size' ? fileExportLimit + 1 : server.content.length,
          ),
          destination,
        );
        expect(c.canExport, false);
        await c.export(origin);
        expect(destination.calls, 0);
        c.dispose();
      }
      expect(server.requests, isEmpty);
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'removal, read failure and mismatched returned bytes prevent handing off',
    () async {
      for (final mode in ['removed', 'read', 'bytes']) {
        final server = ExportServer();
        final f = await fixture(server.handle);
        f.scope.data = server.data;
        final destination = ExportDestination();
        final c = FileExportController(
          f.scope,
          'chat-a',
          ChatFile('file-a', 'report.pdf', server.content.length),
          destination,
        );
        server.missing = mode == 'removed';
        server.failRead = mode == 'read';
        server.wrongSize = mode == 'bytes';
        await c.export(origin);
        expect(destination.calls, 0);
        expect(c.notice, isNull);
        if (mode != 'removed') expect(c.error, isNotNull);
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'scope change while download waits cancels exposure without replay',
    () async {
      final server = ExportServer()..download = Completer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final destination = ExportDestination();
      final c = FileExportController(
        f.scope,
        'chat-a',
        ChatFile('file-a', 'report.pdf', server.content.length),
        destination,
      );
      final pending = c.export(origin);
      while (!server.requests.any((r) => r.url.path.endsWith('/download'))) {
        await Future<void>.delayed(Duration.zero);
      }
      f.session.selectWorkspace(null);
      server.download!.complete(server.bytes());
      await pending;
      expect(destination.calls, 0);
      expect(c.notice, isNull);
      expect(
        server.requests.where((r) => r.url.path.endsWith('/download')).length,
        1,
      );
      expect(f.secrets.values.values.join(), isNot(contains('%PDF')));
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'last authorization before a sheet rejects changed file ownership',
    () async {
      final server = ExportServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final destination = ExportDestination()
        ..beforeHandoff = () async {
          server.conversationId = 'chat-other';
        };
      final c = FileExportController(
        f.scope,
        'chat-a',
        ChatFile('file-a', 'report.pdf', server.content.length),
        destination,
      );
      await c.export(origin);
      expect(destination.calls, 0);
      expect(c.notice, isNull);
      expect(c.error, 'mobileFilesChanged');
      expect(f.scope.find('files', 'file-a')?['conversationId'], 'chat-a');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'double click is ignored and sheet status never claims recipient delivery',
    () async {
      for (final result in FileExportResult.values) {
        final server = ExportServer();
        final f = await fixture(server.handle);
        f.scope.data = server.data;
        final gate = Completer<void>();
        final destination = ExportDestination()
          ..beforeHandoff = (() => gate.future)
          ..result = result;
        final c = FileExportController(
          f.scope,
          'chat-a',
          ChatFile('file-a', 'report.pdf', server.content.length),
          destination,
        );
        final pending = c.export(origin);
        while (server.requests.length < 3) {
          await Future<void>.delayed(Duration.zero);
        }
        await c.export(origin);
        gate.complete();
        await pending;
        expect(destination.calls, 1);
        expect(c.error, isNull);
        expect(
          c.notice,
          {
            FileExportResult.selected: 'mobileFilesExportSelected',
            FileExportResult.dismissed: 'mobileFilesExportDismissed',
            FileExportResult.unknown: 'mobileFilesExportUnknown',
            FileExportResult.saved: 'mobileFilesExportSaved',
          }[result],
        );
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
}

import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/files/website_project_card.dart';
import 'package:openbot_mobile/features/files/website_project_client.dart';
import 'package:openbot_mobile/features/files/website_project_data.dart';
import 'package:openbot_mobile/features/files/website_project_screen.dart';

import 'file_export_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const workspaceId = '11111111-1111-4111-8111-111111111111';

class _Server {
  final assets = {
    'index.html': (
      mime: 'text/html',
      bytes: utf8.encode('<h1>First page</h1>'),
    ),
    'assets/mobile-layout.css': (
      mime: 'text/css',
      bytes: utf8.encode('h1 { color: #105799; }'),
    ),
    'notes/index.html': (
      mime: 'text/html',
      bytes: utf8.encode('<h1>Second page</h1>'),
    ),
    'assets/image.png': (mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47]),
  };
  final requests = <http.Request>[];
  final zip = [0x50, 0x4b, 3, 4, 1, 2, 3];
  bool wrongChecksum = false, manifestChanged = false;

  Json get summary => {
    'id': 'a' * 64,
    'projectKey': 'b' * 64,
    'title': 'Castle game',
    'entry': 'index.html',
    'fileCount': assets.length,
    'totalBytes': assets.values.fold(
      0,
      (size, file) => size + file.bytes.length,
    ),
  };

  Json get message => {
    'id': 'website-card',
    'conversationId': 'chat-a',
    'role': 'assistant',
    'kind': 'website_project',
    'content': 'Castle game',
    'status': 'done',
    'metadata': {'websiteProject': summary},
  };

  Json get manifest => {
    ...summary,
    if (manifestChanged) 'title': 'Wrong snapshot',
    'files': assets.entries
        .map(
          (file) => {
            'path': file.key,
            'mime': file.value.mime,
            'size': file.value.bytes.length,
            'sha256': sha256.convert(file.value.bytes).toString(),
          },
        )
        .toList(),
  };

  Future<http.Response> handle(http.Request request) async {
    requests.add(request);
    expect(request.method, 'GET');
    expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
    expect(request.followRedirects, isFalse);
    final base =
        '/api/workspaces/$workspaceId/website-projects/${summary['id']}';
    final path = request.url.path;
    if (path == base) return jsonResponse(manifest);
    if (path == '$base/download') return _attachment(zip, 'application/zip');
    if (path.startsWith('$base/files/')) {
      final file = assets[path.substring('$base/files/'.length)];
      if (file != null) {
        final bytes = wrongChecksum
            ? List<int>.filled(file.bytes.length, 65)
            : file.bytes;
        return _attachment(bytes, 'application/octet-stream');
      }
    }
    return http.Response('Unexpected path', 404);
  }

  http.Response _attachment(List<int> bytes, String mime) =>
      http.Response.bytes(
        bytes,
        200,
        headers: {
          'content-type': mime,
          'content-disposition': 'attachment; filename="result"',
        },
      );
}

Future<WorkspaceController> _scope(
  _Server server, {
  List<Json>? messages,
}) async {
  final f = await fixture(server.handle);
  f.scope.dispose();
  f.session.workspaces = [
    {...f.session.workspaces.single, 'id': workspaceId},
  ];
  f.session.selectWorkspace(f.session.workspaces.single);
  return WorkspaceController(f.session)
    ..data = bootstrap(messages: messages ?? [server.message]);
}

void main() {
  test(
    'validates role and version and keeps only the latest revision in library',
    () {
      final server = _Server();
      final message = server.message;
      expect(websiteProjectFor({...message, 'role': 'user'}), isNull);
      final invalid = {
        ...message,
        'metadata': {
          'websiteProject': {...server.summary, 'entry': '../index.html'},
        },
      };
      expect(websiteProjectFor(invalid), isNull);
      final later = {
        ...message,
        'id': 'website-card-later',
        'metadata': {
          'websiteProject': {...server.summary, 'id': 'c' * 64},
        },
      };
      expect(latestWebsiteProjects([message, later, invalid]), [later]);
      expect(
        websiteProjectManifest(
          websiteProjectFor(message)!,
          server.manifest,
        ).length,
        4,
      );
      expect(
        () => websiteProjectManifest(websiteProjectFor(message)!, {
          ...server.manifest,
          'totalBytes': 0,
        }),
        throwsFormatException,
      );
    },
  );

  test('asset mismatch and removed message fail closed', () async {
    final server = _Server()..wrongChecksum = true;
    final scope = await _scope(server);
    final client = WebsiteProjectClient(scope, server.message);
    final cancellation = ByteReadCancellation();
    await expectLater(client.load(cancellation), throwsFormatException);
    expect(cancellation.cancelled, isTrue);
    scope.data = bootstrap();
    expect(client.active, isFalse);
    await expectLater(
      client.download(ByteReadCancellation()),
      throwsA(isA<ApiException>()),
    );
    expect(
      server.requests.where(
        (request) => request.url.path.endsWith('/download'),
      ),
      isEmpty,
    );
    scope.dispose();
    scope.session.dispose();
  });

  for (final lang in ['en', 'zh']) {
    testWidgets(
      'full-screen website tabs and ZIP stay reachable at 320px in $lang',
      (tester) async {
        tester.view.physicalSize = const Size(320, 568);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final server = _Server();
        final scope = await _scope(server);
        final destination = ExportDestination();
        await tester.pumpWidget(
          testApp(
            WebsiteProjectScreen(
              client: WebsiteProjectClient(scope, server.message),
              previewBuilder: (_, content) => Text(
                'Preview receives ${content.files.length} checked files',
              ),
              exportDestination: destination,
            ),
            locale: Locale(lang),
          ),
        );
        await waitFor(
          tester,
          () => find
              .text('Preview receives 4 checked files')
              .evaluate()
              .isNotEmpty,
        );
        expect(destination.calls, 0);
        await tester.tap(find.text(lang == 'en' ? 'Source' : '源码'));
        await tester.pumpAndSettle();
        expect(
          find.byWidgetPredicate(
            (widget) =>
                widget is SelectableText && widget.data!.contains('First page'),
          ),
          findsOneWidget,
        );
        await tester.tap(find.byType(DropdownButton<String>));
        await tester.pumpAndSettle();
        await tester.tap(find.text('assets/mobile-layout.css').last);
        await tester.pumpAndSettle();
        expect(
          find.byWidgetPredicate(
            (widget) =>
                widget is SelectableText && widget.data!.contains('#105799'),
          ),
          findsOneWidget,
        );
        await tester.tap(
          find.byTooltip(lang == 'en' ? 'Download project ZIP' : '下载项目 ZIP'),
        );
        await waitFor(tester, () => destination.calls == 1);
        expect(destination.received?.bytes, server.zip);
        expect(destination.received?.mimeType, 'application/zip');
        scope.session.selectWorkspace(null);
        await tester.pumpAndSettle();
        expect(find.byType(SelectableText), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        scope.dispose();
        scope.session.dispose();
      },
    );
  }

  testWidgets(
    'library card opens the authorized latest snapshot, never fetches when browsed',
    (tester) async {
      final server = _Server()..manifestChanged = true;
      final scope = await _scope(server);
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: WebsiteProjectLibrary(
              scope: scope,
              messages: [server.message],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(server.requests, isEmpty);
      await tester.tap(find.byTooltip('Open website project'));
      await waitFor(
        tester,
        () => find
            .text('Could not load the website project. Try again.')
            .evaluate()
            .isNotEmpty,
      );
      expect(server.requests, hasLength(1));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      scope.dispose();
      scope.session.dispose();
    },
  );
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/files/website_project_client.dart';
import 'package:openbot_mobile/features/files/website_share_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _linkRevision = '90000000-0000-4000-8000-000000000001';
const _newRevision = '90000000-0000-4000-8000-000000000002';
final _version = 'a' * 64;
final _tokenPath = '/pages/${'a' * 43}';

Json _projectMessage() => {
  'id': 'website-message',
  'role': 'assistant',
  'kind': 'website_project',
  'conversationId': 'chat-a',
  'metadata': {
    'websiteProject': {
      'id': _version,
      'projectKey': 'b' * 64,
      'title': 'A launch dashboard',
      'entry': 'index.html',
      'fileCount': 3,
      'totalBytes': 105,
    },
  },
};

Json _share(
  String visibility, {
  String? revision,
  List<String> viewers = const [],
}) => {
  'visibility': visibility,
  'revision': revision,
  'versionId': visibility == 'private' ? null : _version,
  'path': visibility == 'private' ? null : _tokenPath,
  'viewerIds': viewers,
};

void _size(WidgetTester tester, double width) {
  tester.view.physicalSize = Size(width, 620);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  testWidgets(
    '320px public link requires review, pins version, copies and revokes',
    (tester) async {
      _size(tester, 320);
      final clipboard = <String>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard.add(call.arguments['text'] as String);
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      final changes = <Json>[];
      final message = _projectMessage();
      final f = await fixture((request) async {
        expect(
          request.url.path,
          '/api/workspaces/space-a/website-projects/$_version/share',
        );
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.method == 'GET') return jsonResponse(_share('private'));
        expect(request.method, 'PUT');
        final body = jsonDecode(request.body) as Json;
        changes.add(body);
        return jsonResponse(
          _share(
            body['visibility'] as String,
            revision: changes.length == 1 ? _linkRevision : _newRevision,
          ),
        );
      });
      f.scope.data = bootstrap(messages: [message]);
      await tester.pumpWidget(
        testApp(
          WebsiteShareScreen(project: WebsiteProjectClient(f.scope, message)),
        ),
      );
      final public = find.text('Anyone with the link');
      await waitFor(tester, () => public.evaluate().isNotEmpty);
      expect(changes, isEmpty);
      expect(find.text('Copy link'), findsNothing);
      await tester.tap(public);
      await tester.pumpAndSettle();
      final save = find.widgetWithText(FilledButton, 'Save access');
      expect(tester.widget<FilledButton>(save).onPressed, isNull);
      expect(changes, isEmpty);
      expect(
        find.text('The link will open the version you approve here.'),
        findsOneWidget,
      );
      final confirmation = find.byType(CheckboxListTile);
      await tester.ensureVisible(confirmation);
      await tester.tap(confirmation);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(save).onPressed, isNotNull);
      await tester.tap(save);
      final copy = find.text('Copy link');
      await waitFor(tester, () => copy.evaluate().isNotEmpty);
      expect(changes, [
        {'visibility': 'public', 'expectedRevision': null},
      ]);
      await tester.ensureVisible(copy);
      await tester.tap(copy);
      await waitFor(tester, () => clipboard.isNotEmpty);
      expect(clipboard, ['https://api.example.test$_tokenPath']);
      final private = find.text('Private to this workspace');
      await tester.ensureVisible(private);
      await tester.pumpAndSettle();
      await tester.tap(private);
      await tester.pumpAndSettle();
      final revoke = find.widgetWithText(FilledButton, 'Revoke link');
      expect(revoke, findsOneWidget);
      await tester.tap(revoke);
      await waitFor(
        tester,
        () => changes.length == 2 && copy.evaluate().isEmpty,
      );
      expect(changes.last, {
        'visibility': 'private',
        'expectedRevision': _linkRevision,
      });
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    '390px invited audience waits for active team roster and may save empty',
    (tester) async {
      _size(tester, 390);
      final members = Completer<http.Response>();
      final changes = <Json>[];
      final message = _projectMessage();
      final f = await fixture((request) async {
        if (request.url.path == '/api/account/workspaces/space-a/team') {
          return members.future;
        }
        expect(
          request.url.path,
          '/api/workspaces/space-a/website-projects/$_version/share',
        );
        if (request.method == 'GET') return jsonResponse(_share('private'));
        expect(request.method, 'PUT');
        final body = jsonDecode(request.body) as Json;
        changes.add(body);
        return jsonResponse(
          _share(
            'invited',
            revision: changes.length == 1 ? _linkRevision : _newRevision,
            viewers: (body['viewerIds'] as List).cast<String>(),
          ),
        );
      });
      final team = {...f.session.workspace!, 'kind': 'team'};
      f.session.selectWorkspace(team);
      f.scope.data = bootstrap(messages: [message]);
      await tester.pumpWidget(
        testApp(
          WebsiteShareScreen(project: WebsiteProjectClient(f.scope, message)),
          locale: const Locale('zh'),
        ),
      );
      final invited = find.text('选定的团队成员');
      await waitFor(tester, () => invited.evaluate().isNotEmpty);
      await tester.tap(invited);
      await tester.pump();
      final save = find.widgetWithText(FilledButton, '保存访问权限');
      expect(tester.widget<FilledButton>(save).onPressed, isNull);
      expect(changes, isEmpty);
      members.complete(
        jsonResponse({
          'members': [
            {'userId': 'active-member', 'name': '有效成员', 'status': 'active'},
            {'userId': 'other-member', 'name': '不可用成员', 'status': 'suspended'},
          ],
        }),
      );
      final active = find.text('有效成员');
      await waitFor(tester, () => active.evaluate().isNotEmpty);
      expect(find.text('不可用成员'), findsNothing);
      expect(tester.widget<FilledButton>(save).onPressed, isNotNull);
      await tester.tap(save);
      await tester.pump();
      final memberChoice = find.widgetWithText(CheckboxListTile, '有效成员');
      await waitFor(
        tester,
        () =>
            changes.length == 1 &&
            tester.widget<CheckboxListTile>(memberChoice).onChanged != null,
      );
      expect(changes.single, {
        'visibility': 'invited',
        'expectedRevision': null,
        'viewerIds': [],
      });
      final checkbox = find.descendant(
        of: memberChoice,
        matching: find.byType(Checkbox),
      );
      await tester.ensureVisible(checkbox);
      await tester.pumpAndSettle();
      await tester.tap(checkbox);
      await tester.pumpAndSettle();
      expect(tester.widget<CheckboxListTile>(memberChoice).value, isTrue);
      expect(tester.widget<FilledButton>(save).onPressed, isNotNull);
      await tester.tap(save);
      await tester.pump();
      await waitFor(
        tester,
        () =>
            changes.length == 2 &&
            tester.widget<CheckboxListTile>(memberChoice).onChanged != null &&
            tester.widget<FilledButton>(save).onPressed == null,
      );
      expect(changes.last, {
        'visibility': 'invited',
        'expectedRevision': _linkRevision,
        'viewerIds': ['active-member'],
      });
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}

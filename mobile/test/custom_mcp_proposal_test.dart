import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/apps/add_connection.dart';
import 'package:openbot_mobile/features/apps/connection_details.dart';
import 'package:openbot_mobile/features/collaboration/proposal_access.dart';
import 'package:openbot_mobile/features/chat/chat_message.dart';

import 'app_connection_proposal_widgets_test.dart' show waitFor;
import 'apps_support.dart';
import 'collaboration_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp;

const _host = 'mcp.example.test';
const _endpoint = 'https://mcp.example.test/team/stream/';

Json _card({String url = _endpoint, String name = _host}) {
  final card = appCard();
  final details = card['metadata']['appConnectionProposal'] as Json;
  details.remove('providerId');
  details['kind'] = 'custom_mcp';
  details['url'] = url;
  details['name'] = name;
  return card;
}

Json _input() => proposalInput()..['content'] = 'Connect $_endpoint';

Json _account({String kind = 'personal'}) =>
    account()..['workspaces'][0]['kind'] = kind;

Json _snapshot(Json card, [List<Json> apps = const []]) =>
    teamSnapshot(messages: [card, _input()])..['apps'] = apps;

Widget _chat(WorkspaceController scope, Json message, String locale) => testApp(
  Scaffold(
    body: ListView(
      children: [ChatMessage(scope: scope, message: message)],
    ),
  ),
  locale: Locale(locale),
);

void _narrow(WidgetTester tester, double width) {
  tester.view
    ..devicePixelRatio = 1
    ..physicalSize = Size(width, 660);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 360));
}

Finder _field(String text) => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.controller?.text == text,
);

bool _detailsReady() =>
    find.byType(ConnectionDetails).evaluate().isNotEmpty &&
    find.byType(LinearProgressIndicator).evaluate().isEmpty;

void main() {
  test('custom card admits only its own bounded HTTPS metadata branch', () {
    expect(appProposal(_card())?['url'], _endpoint);
    for (final url in [
      'http://$_host/mcp',
      'https://$_host:444/mcp',
      'https://user@$_host/mcp',
      'https://$_host/mcp?a=b',
      'https://$_host/mcp#fragment',
      'https://$_host/mcp path',
      'https://$_host/mcp\\path',
      'https://localhost/mcp',
    ]) {
      expect(appProposal(_card(url: url)), isNull, reason: url);
    }
    expect(appProposal(_card(name: 'Lookalike')), isNull);
    final mixed = _card()
      ..['metadata']['appConnectionProposal']['providerId'] = 'notion';
    expect(appProposal(mixed), isNull);
  });

  test(
    'a custom card must still bind to the requester, local Bot and exact direct thread',
    () async {
      for (final variant in [
        'valid',
        'team',
        'group',
        'shared',
        'different thread',
        'different requester',
        'different URL',
      ]) {
        final card = _card()..['threadRootId'] = 'thread-root';
        final actual = _card()..['threadRootId'] = 'thread-root';
        final data = _snapshot(actual);
        data['messages'][1]['threadRootId'] = 'thread-root';
        if (variant == 'group') data['conversations'][0]['isGroup'] = true;
        if (variant == 'shared') {
          data['agents'][0]['sharedBot'] = {'status': 'active'};
        }
        if (variant == 'different thread') {
          data['messages'][1]['threadRootId'] = 'wrong-thread';
        }
        if (variant == 'different requester') {
          data['messages'][1]['userId'] = 'user-b';
        }
        if (variant == 'different URL') {
          actual['metadata']['appConnectionProposal']['url'] =
              'https://$_host/another/';
        }
        final f = await fixture((request) async {
          expect(request.method, 'GET');
          return jsonResponse(
            request.url.path.endsWith('/session')
                ? _account(kind: variant == 'team' ? 'team' : 'personal')
                : data,
          );
        });
        f.scope.data = _snapshot(card);
        final access = ProposalAccess(f.scope);
        if (variant == 'valid') {
          expect((await access.app(card))['url'], _endpoint);
        } else {
          await expectLater(
            access.app(card),
            throwsA(isA<ApiException>()),
            reason: variant,
          );
        }
        access.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );

  testWidgets('320px review locks the URL and requires explicit sharing', (
    tester,
  ) async {
    _narrow(tester, 320);
    final card = _card();
    final wrong = connectedApp(id: 'alias', name: _host)
      ..['url'] = 'https://$_host/team/stream';
    final saved = connectedApp(id: 'exact', name: 'Reviewed server')
      ..['url'] = _endpoint;
    final writes = <Json>[];
    final f = await fixture((request) async {
      if (request.url.path.endsWith('/session')) {
        return jsonResponse(_account());
      }
      final apps = [wrong, if (writes.isNotEmpty) saved];
      if (request.url.path.endsWith('/bootstrap')) {
        return jsonResponse(_snapshot(card, apps));
      }
      expect(request.url.path.endsWith('/apps'), isTrue);
      if (request.method == 'POST') {
        writes.add(jsonDecode(request.body) as Json);
        return jsonResponse(saved, status: 201);
      }
      expect(request.method, 'GET');
      return jsonResponse(apps);
    });
    f.scope.data = _snapshot(card, [wrong]);
    await tester.pumpWidget(_chat(f.scope, card, 'zh'));
    await waitFor(tester, () => find.text('核对并连接').evaluate().isNotEmpty);
    expect(find.text('自定义 MCP 服务'), findsOneWidget);
    expect(find.widgetWithText(SelectableText, _endpoint), findsOneWidget);
    expect(find.text('未配置'), findsOneWidget);
    await _tap(tester, find.text('核对并连接'));
    await waitFor(tester, () => _field(_endpoint).evaluate().isNotEmpty);
    expect(find.byType(AddConnection), findsOneWidget);
    expect(tester.widget<TextField>(_field(_endpoint)).readOnly, isTrue);
    expect(tester.widget<TextField>(_field(_host)).readOnly, isFalse);
    expect(
      tester
          .widget<DropdownButtonFormField<String>>(
            find.byType(DropdownButtonFormField<String>),
          )
          .initialValue,
      'none',
    );
    final share = find.byType(CheckboxListTile);
    final save = find.widgetWithText(FilledButton, '保存连接');
    expect(tester.widget<CheckboxListTile>(share).value, isFalse);
    expect(tester.widget<FilledButton>(save).onPressed, isNull);
    expect(writes, isEmpty);
    await tester.enterText(_field(_host), 'Reviewed server');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await _tap(tester, share);
    expect(writes, isEmpty);
    await _tap(tester, save);
    await waitFor(tester, _detailsReady);
    expect(writes, [
      {
        'name': 'Reviewed server',
        'url': _endpoint,
        'authType': 'none',
        'shared': true,
      },
    ]);
    expect(
      tester
          .widget<ConnectionDetails>(find.byType(ConnectionDetails))
          .connectionId,
      'exact',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('390px a duplicate response reopens only the exact connection', (
    tester,
  ) async {
    _narrow(tester, 390);
    final card = _card();
    final alias = connectedApp(id: 'alias', name: _host)
      ..['url'] = 'https://$_host/team/stream';
    final exact = connectedApp(id: 'exact', name: 'Already connected')
      ..['url'] = _endpoint;
    var writes = 0;
    var readAfterDuplicate = false;
    final f = await fixture((request) async {
      if (request.url.path.endsWith('/session')) {
        return jsonResponse(_account());
      }
      final apps = [alias, if (writes > 0) exact];
      if (request.url.path.endsWith('/bootstrap')) {
        return jsonResponse(_snapshot(card, apps));
      }
      expect(request.url.path.endsWith('/apps'), isTrue);
      if (request.method == 'POST') {
        writes++;
        expect((jsonDecode(request.body) as Json)['url'], _endpoint);
        return jsonResponse({
          'code': 'APP_CONNECTION_EXISTS',
          'error': 'Exact connection already exists',
        }, status: 409);
      }
      expect(request.method, 'GET');
      if (writes > 0) readAfterDuplicate = true;
      return jsonResponse(apps);
    });
    f.scope.data = _snapshot(card, [alias]);
    await tester.pumpWidget(_chat(f.scope, card, 'en'));
    await waitFor(
      tester,
      () => find.text('Review and connect').evaluate().isNotEmpty,
    );
    await _tap(tester, find.text('Review and connect'));
    await waitFor(tester, () => _field(_endpoint).evaluate().isNotEmpty);
    await _tap(tester, find.byType(CheckboxListTile));
    await _tap(tester, find.widgetWithText(FilledButton, 'Save connection'));
    await waitFor(tester, _detailsReady);
    expect(readAfterDuplicate, isTrue);
    expect(writes, 1);
    final details = tester.widget<ConnectionDetails>(
      find.byType(ConnectionDetails),
    );
    expect(details.connectionId, 'exact');
    expect(details.controller.pendingFor(), isNull);
    await tester.pageBack();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 360));
    await waitFor(
      tester,
      () =>
          find.text('Open connection').evaluate().isNotEmpty &&
          find.byType(ConnectionDetails).evaluate().isEmpty,
    );
    expect(find.text('Connected'), findsOneWidget);
    await _tap(tester, find.text('Open connection'));
    await waitFor(tester, _detailsReady);
    expect(
      tester
          .widget<ConnectionDetails>(find.byType(ConnectionDetails))
          .connectionId,
      'exact',
    );
    expect(find.byType(AddConnection), findsNothing);
    expect(writes, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}

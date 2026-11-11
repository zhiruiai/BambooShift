import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/chat_draft.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/inbound_share/inbound_share_bridge.dart';
import 'package:openbot_mobile/features/inbound_share/inbound_share_data.dart';
import 'package:openbot_mobile/features/inbound_share/inbound_share_draft.dart';
import 'package:openbot_mobile/features/inbound_share/inbound_share_inbox.dart';
import 'package:openbot_mobile/features/inbound_share/inbound_share_screen.dart';
import 'package:openbot_mobile/features/workspaces/workspace_screen.dart';

import 'attachment_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _packet = '10000000-0000-4000-8000-000000000001';
const _nextPacket = '10000000-0000-4000-8000-000000000002';
const _file = '10000000-0000-4000-8000-000000000003';
const _extra = '10000000-0000-4000-8000-000000000004';
const _link = 'https://source.example.test/document';

Json _fileMeta(String id, String name, int size) => {
  'id': id,
  'name': name,
  'type': 'text/plain',
  'size': size,
};

Json _input({
  String id = _packet,
  String? text = _link,
  List<Json> files = const [],
}) => {'id': id, 'text': text, 'files': files};

class _Bridge implements InboundShareBridge {
  final queue = <Json>[];
  final bytes = <String, Uint8List>{};
  final reads = <({String id, String fileId, int offset, int length})>[];
  final discards = <String>[];
  VoidCallback? changed;
  Completer<void>? holdRead;

  @override
  void listen(VoidCallback? callback) => changed = callback;

  @override
  Future<Object?> peek() async => queue.firstOrNull;

  @override
  Future<Uint8List?> read(
    String id,
    String fileId,
    int offset,
    int length,
  ) async {
    reads.add((id: id, fileId: fileId, offset: offset, length: length));
    expect(length, lessThanOrEqualTo(inboundShareChunk));
    await holdRead?.future;
    return Uint8List.sublistView(bytes[fileId]!, offset, offset + length);
  }

  @override
  Future<bool> discard(String id) async {
    discards.add(id);
    queue.removeWhere((item) => item['id'] == id);
    return true;
  }
}

void main() {
  test('share metadata blocks local URLs, traversal and oversize files', () {
    expect(InboundSharePacket.parse(_input(text: _link))?.text, _link);
    expect(
      InboundSharePacket.parse(_input(text: 'File: Project notes'))?.text,
      'File: Project notes',
    );
    expect(InboundSharePacket.parse(_input(id: '../wrong')), isNull);
    for (final raw in [
      'file:///secret',
      'content://device/private',
      'https://user@source.example.test',
    ]) {
      expect(InboundSharePacket.parse(_input(text: raw))?.text, isNull);
    }
    final parsed = InboundSharePacket.parse(
      _input(
        files: [
          _fileMeta(_file, '../private.txt', 2),
          _fileMeta(_extra, 'huge.txt', 10485761),
        ],
      ),
    );
    expect(parsed?.files, isEmpty);
    expect(parsed?.warning, 'mobileInboundLimited');
  });

  testWidgets('native bridge uses only exact metadata and chunk calls', (
    tester,
  ) async {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final calls = <MethodCall>[];
    const bridge = NativeInboundShare();
    messenger.setMockMethodCallHandler(NativeInboundShare.channel, (
      call,
    ) async {
      calls.add(call);
      return switch (call.method) {
        'peek' => _input(),
        'read' => Uint8List.fromList([4, 5]),
        'discard' => true,
        _ => null,
      };
    });
    addTearDown(
      () =>
          messenger.setMockMethodCallHandler(NativeInboundShare.channel, null),
    );
    expect(InboundSharePacket.parse(await bridge.peek())?.id, _packet);
    expect(await bridge.read(_packet, _file, 65536, 2), [4, 5]);
    expect(await bridge.discard(_packet), isTrue);
    expect(calls.map((call) => call.method), ['peek', 'read', 'discard']);
    expect(calls[1].arguments, {
      'id': _packet,
      'fileId': _file,
      'offset': 65536,
      'length': 2,
    });
    expect(calls[2].arguments, {'id': _packet});
  });

  for (final language in ['zh', 'en']) {
    testWidgets(
      '320px $language review stages selected files and text without upload or send',
      (tester) async {
        tester.view.physicalSize = const Size(320, 620);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final server = AttachmentServer();
        final f = await fixture(server.handle);
        await tester.runAsync(f.scope.refresh);
        f.scope.saveChatDraft('chat-a', 'Existing draft');
        final bridge = _Bridge()
          ..bytes[_file] = Uint8List(65539)
          ..bytes[_extra] = Uint8List(4);
        final inbox = InboundShareInbox(f.session, bridge)..start();
        bridge.queue.add(
          _input(
            files: [
              _fileMeta(_file, 'notes.txt', 65539),
              _fileMeta(_extra, 'data.txt', 4),
            ],
          ),
        );
        inbox.didChangeAppLifecycleState(AppLifecycleState.resumed);
        await waitFor(tester, () => inbox.packet != null);
        await tester.pumpWidget(
          testApp(
            Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () async {
                    final result = await Navigator.of(context).push<String>(
                      MaterialPageRoute(
                        builder: (_) => InboundShareScreen(
                          scope: f.scope,
                          inbox: inbox,
                          packet: inbox.packet!,
                        ),
                      ),
                    );
                    if (result != null && context.mounted) {
                      await Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => ChatScreen(
                            scope: f.scope,
                            conversationId: result,
                          ),
                        ),
                      );
                    }
                  },
                  child: const Text('Open share'),
                ),
              ),
            ),
            locale: Locale(language),
          ),
        );
        await tester.tap(find.text('Open share'));
        await tester.pumpAndSettle();
        expect(find.text(_link), findsOneWidget);
        expect(find.text('notes.txt'), findsOneWidget);
        final add = find.ancestor(
          of: find.text(language == 'en' ? 'Add to draft' : '加入草稿'),
          matching: find.byWidgetPredicate((widget) => widget is FilledButton),
        );
        expect(tester.widget<FilledButton>(add).onPressed, isNull);
        expect(bridge.reads, isEmpty);
        final conversation = find.text('Example');
        await tester.ensureVisible(conversation);
        await tester.pumpAndSettle();
        await tester.tap(conversation);
        await tester.pumpAndSettle();
        expect(tester.widget<FilledButton>(add).onPressed, isNotNull);
        expect(
          server.requests.where((request) => request.method == 'POST'),
          isEmpty,
        );
        await tester.tap(add);
        await tester.pump();
        await waitFor(
          tester,
          () =>
              find.byType(ChatScreen).evaluate().isNotEmpty &&
              bridge.discards.isNotEmpty,
        );
        expect(f.scope.chatDraft('chat-a'), 'Existing draft\n\n$_link');
        final input = find.descendant(
          of: find.byType(ChatScreen),
          matching: find.byType(TextField),
        );
        expect(
          tester.widget<TextField>(input).controller!.text,
          'Existing draft\n\n$_link',
        );
        expect(f.scope.attachmentDrafts('chat-a').map((file) => file.name), [
          'notes.txt',
          'data.txt',
        ]);
        expect(bridge.reads.map((read) => (read.offset, read.length)), [
          (0, 65536),
          (65536, 3),
          (0, 4),
        ]);
        expect(bridge.discards, [_packet]);
        expect(
          server.requests.where((request) => request.method == 'POST'),
          isEmpty,
        );
        expect(
          tester
              .widget<FilledButton>(
                find.ancestor(
                  of: find.byIcon(Icons.arrow_upward),
                  matching: find.byType(FilledButton),
                ),
              )
              .onPressed,
          isNull,
        );
        tester.view.viewInsets = const FakeViewPadding(bottom: 320);
        await tester.pumpAndSettle();
        tester.view.resetViewInsets();
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        inbox.dispose();
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }

  testWidgets(
    'warm share opens review above a chat and remains available after closing',
    (tester) async {
      final server = AttachmentServer();
      final f = await fixture(server.handle);
      final bridge = _Bridge();
      final inbox = InboundShareInbox(f.session, bridge)..start();
      await tester.pumpWidget(
        testApp(WorkspaceScreen(session: f.session, inboundShare: inbox)),
      );
      await waitFor(tester, () => find.text('Example').evaluate().isNotEmpty);
      await tester.tap(find.text('Example'));
      await tester.pumpAndSettle();
      expect(find.byType(ChatScreen), findsOneWidget);
      bridge.queue.add(_input());
      bridge.changed!.call();
      await waitFor(
        tester,
        () => find.byType(InboundShareScreen).evaluate().isNotEmpty,
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byType(ChatScreen), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byType(InboundShareScreen), findsNothing);
      expect(find.byTooltip('Shared with BambooShift'), findsOneWidget);
      expect(bridge.reads, isEmpty);
      expect(bridge.discards, isEmpty);
      expect(
        server.requests.where((request) => request.method == 'POST'),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(seconds: 10));
      inbox.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'account switch during a file read cannot stage old data or reveal queued items',
    (tester) async {
      final f = await fixture((_) async => jsonResponse(bootstrap()));
      final bridge = _Bridge()
        ..queue.addAll([
          _input(files: [_fileMeta(_file, 'private.txt', 4)]),
          _input(id: _nextPacket),
        ])
        ..bytes[_file] = Uint8List(4)
        ..holdRead = Completer<void>();
      final inbox = InboundShareInbox(f.session, bridge)..start();
      await waitFor(tester, () => inbox.packet != null);
      final attaching = attachInboundShare(
        scope: f.scope,
        inbox: inbox,
        packet: inbox.packet!,
        conversationId: 'chat-a',
        includeText: true,
        fileIds: {_file},
        isCurrent: () => true,
      );
      final failed = expectLater(
        attaching,
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'STALE_SCOPE'),
        ),
      );
      await waitFor(tester, () => bridge.reads.isNotEmpty);
      f.session.user = {'id': 'user-b'};
      f.session.selectWorkspace(f.session.workspaces.single);
      bridge.holdRead!.complete();
      await failed;
      await waitFor(tester, () => bridge.discards.length == 2);
      expect(inbox.packet, isNull);
      expect(f.scope.chatDraft('chat-a'), isEmpty);
      expect(f.scope.attachmentDrafts('chat-a'), isEmpty);
      inbox.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'unconfirmed send stops incoming files before any local byte read',
    (tester) async {
      final f = await fixture((_) async => jsonResponse(bootstrap()));
      final bridge = _Bridge()
        ..queue.add(_input(files: [_fileMeta(_file, 'file.txt', 4)]));
      final inbox = InboundShareInbox(f.session, bridge)..start();
      await waitFor(tester, () => inbox.packet != null);
      await f.session.api.vault.write(
        f.session.api.server!.origin,
        chatPendingPurpose(f.scope.userId, f.scope.workspaceId, 'chat-a'),
        jsonEncode({'content': 'Pending'}),
      );
      await expectLater(
        attachInboundShare(
          scope: f.scope,
          inbox: inbox,
          packet: inbox.packet!,
          conversationId: 'chat-a',
          includeText: true,
          fileIds: {_file},
          isCurrent: () => true,
        ),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'PENDING_SEND'),
        ),
      );
      expect(bridge.reads, isEmpty);
      expect(bridge.discards, isEmpty);
      expect(inbox.packet?.id, _packet);
      inbox.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}

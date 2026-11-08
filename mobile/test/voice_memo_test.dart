import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/chat_draft.dart';
import 'package:openbot_mobile/features/chat/chat_controller.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/voice/voice_memo_data.dart';
import 'package:openbot_mobile/features/voice/voice_memo_transport.dart';

import 'support.dart';
import 'voice_call_test.dart' show sampleWave;
import 'widgets_test.dart' show testApp, waitFor;

class _Player extends VoiceMemoTransport {
  bool playing = false;
  String? id;
  int starts = 0, stops = 0, resumes = 0, pauses = 0;
  @override
  bool get supported => true;

  @override
  Future<void> play(String id, Uint8List wav) async {
    expect(wav, sampleWave());
    starts++;
    this.id = id;
    playing = true;
  }

  @override
  Future<void> pause(String id) async {
    expect(id, this.id);
    pauses++;
    playing = false;
  }

  @override
  Future<void> resume(String id) async {
    expect(id, this.id);
    resumes++;
    playing = true;
  }

  @override
  Future<({bool playing, int positionMs})?> status(String id) async =>
      id == this.id ? (playing: playing, positionMs: 100) : null;

  @override
  Future<void> stop(String id) async {
    if (id == this.id) {
      stops++;
      playing = false;
      this.id = null;
    }
  }
}

class _Server {
  bool available = true, group = false, shared = false;
  bool deleted = false, corrupt = false, loseResponse = false;
  int reads = 0;
  final sends = <Json>[];
  final messages = <Json>[];
  final wav = sampleWave();
  Json get file => {
    'id': 'memo-a',
    'name': 'Reply.wav',
    'type': 'audio/wav',
    'size': wav.length,
    'sha256': sha256.convert(wav).toString(),
    'conversationId': 'chat-a',
  };

  Json get memo => {
    'id': 'assistant-memo-a',
    'conversationId': 'chat-a',
    'role': 'assistant',
    'kind': 'file',
    'status': 'done',
    'content': 'Reply.wav',
    'agentId': 'bot-a',
    'metadata': {
      'fileId': 'memo-a',
      'name': 'Reply.wav',
      'size': wav.length,
      'sha256': sha256.convert(wav).toString(),
      'voiceMemo': {
        'transcript': '这是一条语音留言的文字。',
        'durationMs': (wav.length - 44) ~/ 32,
      },
    },
  };

  Future<http.Response> handle(http.Request request) async {
    final path = request.url.path;
    if (path.endsWith('/bootstrap')) {
      return jsonResponse({
        ...bootstrap(
          messages: messages,
          agents: [
            {
              'id': 'bot-a',
              'name': 'Example Bot',
              if (shared) 'sharedBot': {'status': 'active', 'available': true},
            },
          ],
        ),
        'voiceMemo': {'available': available},
        'settings': {'configured': true},
        'conversations': [
          {
            'id': 'chat-a',
            'agentIds': ['bot-a'],
            'title': 'Example',
            'isGroup': group,
          },
        ],
        'files': [if (!deleted) file],
      });
    }
    if (path.endsWith('/files/memo-a/download')) {
      expect(request.headers['x-openbot-expected-user'], 'user-a');
      reads++;
      final bytes = Uint8List.fromList(wav);
      if (corrupt) bytes[80] ^= 1;
      return http.Response.bytes(
        bytes,
        200,
        headers: {
          'content-type': 'audio/wav',
          'content-disposition': 'attachment; filename="Reply.wav"',
        },
      );
    }
    if (path.endsWith('/messages') && request.method == 'POST') {
      final body = jsonDecode(request.body) as Json;
      sends.add(body);
      final row = {
        'id': 'memo-request-a',
        'role': 'user',
        'kind': 'text',
        'conversationId': 'chat-a',
        'userId': 'user-a',
        'content': body['content'],
        'delivery': {'clientId': body['clientId']},
        if (!loseResponse && body['requestVoiceMemo'] == true)
          'metadata': {'requestVoiceMemo': true},
      };
      if (!loseResponse) {
        messages.add(row);
        if (body['requestVoiceMemo'] == true) messages.add(memo);
      }
      return jsonResponse({'message': row});
    }
    return jsonResponse({});
  }
}

void main() {
  testWidgets(
    '320px Chinese requests and plays a memo, retaining text after deletion',
    (tester) async {
      tester.view.physicalSize = const Size(320, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = _Server();
      final account = await fixture(server.handle);
      final player = _Player();
      await tester.runAsync(account.scope.refresh);
      await tester.pumpWidget(
        testApp(
          ChatScreen(
            scope: account.scope,
            conversationId: 'chat-a',
            memoTransport: player,
          ),
          locale: const Locale('zh'),
        ),
      );
      final chip = find.widgetWithText(FilterChip, '用语音留言回复');
      await waitFor(tester, () => chip.evaluate().isNotEmpty);
      expect(server.reads, 0);
      await tester.tap(chip);
      await tester.enterText(find.byType(TextField), '请用语音回复');
      await tester.pump();
      await tester.tap(find.byIcon(Icons.arrow_upward));
      await waitFor(
        tester,
        () => find.byTooltip('播放语音留言').evaluate().isNotEmpty,
      );
      expect(server.sends.single['requestVoiceMemo'], true);
      expect(server.sends.single['mode'], 'followUp');
      expect(tester.widget<FilterChip>(chip).selected, isFalse);
      expect(server.reads, 0);
      await tester.tap(find.byTooltip('播放语音留言'));
      await waitFor(
        tester,
        () => find.byTooltip('暂停语音留言').evaluate().isNotEmpty,
      );
      expect(server.reads, 1);
      expect(player.starts, 1);
      await tester.tap(find.byTooltip('暂停语音留言'));
      await waitFor(
        tester,
        () => find.byTooltip('播放语音留言').evaluate().isNotEmpty,
      );
      expect(player.pauses, 1);
      await tester.tap(find.byTooltip('播放语音留言'));
      await waitFor(tester, () => player.resumes == 1);
      expect(server.reads, 1);
      for (final state in [
        AppLifecycleState.inactive,
        AppLifecycleState.hidden,
        AppLifecycleState.paused,
        AppLifecycleState.hidden,
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
      ]) {
        tester.binding.handleAppLifecycleStateChanged(state);
      }
      await waitFor(tester, () => player.stops == 1);
      expect(server.reads, 1);
      server.deleted = true;
      await tester.runAsync(account.scope.refresh);
      await waitFor(tester, () => find.text('语音文件已不可用。').evaluate().isNotEmpty);
      expect(find.byTooltip('播放语音留言'), findsNothing);
      await tester.tap(find.text('文字记录'));
      await tester.pumpAndSettle();
      expect(find.text('这是一条语音留言的文字。'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      account.scope.dispose();
      account.session.dispose();
    },
  );

  testWidgets('390px English never plays a changed or corrupt file', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final server = _Server()
      ..available = false
      ..corrupt = true;
    server.messages.add(server.memo);
    final account = await fixture(server.handle);
    final player = _Player();
    await tester.runAsync(account.scope.refresh);
    await tester.pumpWidget(
      testApp(
        ChatScreen(
          scope: account.scope,
          conversationId: 'chat-a',
          memoTransport: player,
        ),
      ),
    );
    final play = find.byTooltip('Play voice memo');
    await waitFor(tester, () => play.evaluate().isNotEmpty);
    expect(
      find.widgetWithText(FilterChip, 'Reply with a voice memo'),
      findsNothing,
    );
    await tester.tap(play);
    await waitFor(
      tester,
      () => find.textContaining('Could not play').evaluate().isNotEmpty,
    );
    expect(player.starts, 0);
    expect(server.reads, 1);
    await tester.pumpWidget(const SizedBox.shrink());
    account.scope.dispose();
    account.session.dispose();
  });

  test(
    'voice memo acknowledgement binds exact intent and a retry keeps the request ID',
    () async {
      final server = _Server()..loseResponse = true;
      final account = await fixture(server.handle);
      await account.scope.refresh();
      final chat = ChatController(account.scope, 'chat-a');
      await chat.initialize();
      expect(await chat.send('memo', requestVoiceMemo: true), false);
      final original = Map<String, dynamic>.of(chat.pending!);
      expect(original['requestVoiceMemo'], true);
      expect(chat.lastReceipt, isNull);
      server.loseResponse = false;
      await chat.retry();
      expect(chat.pending, isNull);
      expect(chat.lastReceipt?['metadata']?['requestVoiceMemo'], true);
      expect(server.sends, [original, original]);
      chat.dispose();
      account.scope.dispose();
      account.session.dispose();
    },
  );

  test(
    'voice memo capability excludes team, shared, groups and extra context',
    () async {
      final server = _Server();
      final account = await fixture(server.handle);
      await account.scope.refresh();
      bool allowed([ChatDraftOptions options = emptyChatOptions]) =>
          canRequestVoiceMemo(account.scope, 'chat-a', null, options);
      expect(allowed(), true);
      expect(allowed(emptyChatOptions.withReply('other')), false);
      expect(
        canRequestVoiceMemo(account.scope, 'chat-a', 'root', emptyChatOptions),
        false,
      );
      server.shared = true;
      await account.scope.refresh();
      expect(allowed(), false);
      server.shared = false;
      server.group = true;
      await account.scope.refresh();
      expect(allowed(), false);
      server.group = false;
      await account.scope.refresh();
      account.session.workspace = {
        ...account.session.workspace!,
        'kind': 'team',
      };
      expect(allowed(), false);
      account.scope.dispose();
      account.session.dispose();
    },
  );
}

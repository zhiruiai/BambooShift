import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/attachment_storage.dart';
import 'package:openbot_mobile/features/chat/chat_controller.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/voice/voice_api.dart';
import 'package:openbot_mobile/features/voice/voice_transport.dart';

import 'attachment_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const otherCallId = '243ec79d-291d-4d94-8c6b-f749515ad98b';

Uint8List sampleWave() {
  final bytes = Uint8List(3644);
  final data = ByteData.sublistView(bytes);
  void tag(int offset, String value) =>
      bytes.setRange(offset, offset + 4, value.codeUnits);
  tag(0, 'RIFF');
  data.setUint32(4, bytes.length - 8, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  data.setUint32(16, 16, Endian.little);
  for (final entry in {20: 1, 22: 1, 32: 2, 34: 16}.entries) {
    data.setUint16(entry.key, entry.value, Endian.little);
  }
  data.setUint32(24, 16000, Endian.little);
  data.setUint32(28, 32000, Endian.little);
  tag(36, 'data');
  data.setUint32(40, bytes.length - 44, Endian.little);
  for (var i = 44; i < bytes.length; i += 2) {
    data.setInt16(i, i % 4 == 0 ? 1200 : -1200, Endian.little);
  }
  return bytes;
}

class TestVoiceTransport extends VoiceTransport {
  bool denied = false;
  int recordings = 0;
  int stops = 0;
  final preparations = <bool>[];
  final spoken = <(String, String)>[];
  Completer<Uint8List?>? capturing;
  Completer<void>? playback;

  @override
  bool get supported => true;

  @override
  Future<void> prepare({required bool playback}) async {
    preparations.add(playback);
    if (denied) throw PlatformException(code: 'voice_permission');
  }

  @override
  Future<Uint8List?> record({required bool automatic, required int seconds}) {
    expect(seconds, 60);
    expect(capturing?.isCompleted ?? true, isTrue);
    recordings++;
    return (capturing = Completer()).future;
  }

  @override
  Future<void> finish() async {
    capturing!.complete(sampleWave());
  }

  @override
  Future<void> speak(String text, String language) {
    spoken.add((text, language));
    return (playback = Completer()).future;
  }

  @override
  Future<void> stop() async {
    stops++;
    if (capturing?.isCompleted == false) capturing!.complete(null);
    if (playback?.isCompleted == false) playback!.complete();
  }
}

class TestVoiceServer extends AttachmentServer {
  String? callId, openCallId;
  bool group = false, loseSend = false, wrongUser = false, wrongReceipt = false;
  int starts = 0, ends = 0, transcriptions = 0;
  final sent = <Json>[];

  Json call(String id, {bool ended = false, String conversation = 'chat-a'}) {
    final now = DateTime.now().toUtc();
    return {
      'id': id,
      'conversationId': conversation,
      'agentId': 'bot-a',
      'userId': 'user-a',
      'startedAt': now.toIso8601String(),
      'expiresAt': now.add(const Duration(minutes: 15)).toIso8601String(),
      if (ended) 'endedAt': now.toIso8601String(),
    };
  }

  @override
  Future<http.Response> handle(http.Request r) async {
    final path = r.url.path;
    if (path.endsWith('/bootstrap') && group) {
      return jsonResponse({
        ...bootstrap(
          messages: messages,
          agents: [
            {'id': 'bot-a', 'name': 'Example Bot'},
          ],
        ),
        'conversations': [
          {
            'id': 'chat-a',
            'title': 'Group',
            'agentIds': ['bot-a'],
            'isGroup': true,
          },
        ],
        'settings': {'configured': true},
      });
    }
    if (path.endsWith('/speech/status')) {
      return jsonResponse({
        'available': true,
        'processing': 'server-local',
        'format': 'wav-pcm16-mono-16000',
        'maxSeconds': 60,
        'maxBytes': 2097152,
      });
    }
    if (path.endsWith('/speech/transcribe')) {
      transcriptions++;
      expect(r.headers['x-openbot-expected-user'], 'user-a');
      expect(r.headers['content-type'], 'audio/wav');
      expect(r.headers['x-openbot-voice-call'], callId);
      expect(validVoiceWave(r.bodyBytes, 60), isTrue);
      return jsonResponse({
        'userId': wrongUser ? 'different-user' : 'user-a',
        'text': '示例问题',
        'durationMs': 112,
      });
    }
    if (path.endsWith('/voice-calls') && r.method == 'GET') {
      return jsonResponse({
        'call': openCallId == null
            ? null
            : call(openCallId!, conversation: 'another-chat'),
      });
    }
    if (path.endsWith('/voice-calls') && r.method == 'POST') {
      final body = jsonDecode(r.body) as Json;
      starts++;
      expect(body['replaceId'], openCallId);
      callId = body['id'] as String;
      return jsonResponse({'call': call(callId!)});
    }
    if (path.endsWith('/end')) {
      expect(path, endsWith('/voice-calls/$callId/end'));
      expect(r.headers['x-openbot-expected-user'], 'user-a');
      ends++;
      if (sent.isNotEmpty) {
        messages.add({
          'id': 'finished-call',
          'role': 'system',
          'kind': 'voice_call',
          'conversationId': 'chat-a',
          'userId': 'user-a',
          'metadata': {
            'voiceCall': {'id': callId, 'durationMs': 65000},
          },
        });
      }
      return jsonResponse({'call': call(callId!, ended: true)});
    }
    if (path.endsWith('/messages') && r.method == 'POST') {
      final body = jsonDecode(r.body) as Json;
      expect(body['voiceCallId'], callId);
      sent.add(body);
      final row = {
        'id': 'voice-input',
        'role': 'user',
        'kind': 'text',
        'conversationId': 'chat-a',
        'userId': 'user-a',
        'content': body['content'],
        'delivery': {'clientId': body['clientId'], 'runId': 'voice-run'},
        'metadata': {'voiceCallId': callId},
      };
      if (messages.every((item) => item['id'] != 'voice-input')) {
        messages.add(row);
        messages.addAll([
          reply('progress', 'Tool progress', terminal: false),
          reply('wrong-input', 'Wrong input', input: 'older-input'),
          reply('delegate', 'Delegated text', delegated: true),
          reply('final', '**语音回复**'),
        ]);
      }
      if (loseSend) throw http.ClientException('Synthetic lost response');
      return jsonResponse({
        'message': wrongReceipt
            ? {
                ...row,
                'metadata': {
                  'voiceCallId': '3a74515a-3fe8-42f5-9fe3-f903ae240af1',
                },
              }
            : row,
      });
    }
    return super.handle(r);
  }

  Json reply(
    String id,
    String content, {
    bool terminal = true,
    bool delegated = false,
    String input = 'voice-input',
  }) => {
    'id': id,
    'role': 'assistant',
    'kind': 'text',
    'status': 'done',
    'conversationId': 'chat-a',
    'agentId': 'bot-a',
    'content': content,
    'metadata': {
      'voiceCallId': callId,
      'voiceCallTerminal': terminal,
      'inputMessageId': input,
      'runId': 'voice-run',
      if (delegated) 'delegation': {'rootRunId': 'voice-run'},
    },
  };
}

Future<void> closeChat(WidgetTester tester, VoidCallback close) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
  close();
}

void main() {
  testWidgets(
    '320px Chinese live voice loops, mutes and persists a transcript',
    (tester) async {
      tester.view.physicalSize = const Size(320, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = TestVoiceServer()..openCallId = otherCallId;
      final value = await fixture(server.handle);
      final audio = TestVoiceTransport();
      await tester.runAsync(value.scope.refresh);
      await tester.pumpWidget(
        testApp(
          ChatScreen(
            scope: value.scope,
            conversationId: 'chat-a',
            voiceTransport: audio,
          ),
          locale: const Locale('zh'),
        ),
      );
      final start = find.byTooltip('开始语音通话');
      await waitFor(tester, () => start.evaluate().isNotEmpty);
      await tester.enterText(find.byType(TextField), '未发出的草稿');
      await tester.pump();
      expect(start, findsNothing);
      await tester.enterText(find.byType(TextField), '');
      await tester.pump();
      await tester.tap(start);
      await waitFor(tester, () => find.text('结束并开始通话').evaluate().isNotEmpty);
      expect(audio.preparations, isEmpty);
      expect(server.starts, 0);
      await tester.tap(find.text('结束并开始通话'));
      await tester.pumpAndSettle();
      await waitFor(tester, () => audio.recordings == 1);
      expect(audio.preparations, [true]);
      expect(server.sent, isEmpty);
      expect(find.text('正在听…'), findsOneWidget);
      audio.capturing!.complete(sampleWave());
      await waitFor(tester, () => audio.spoken.isNotEmpty);
      expect(audio.spoken, [('语音回复', 'zh')]);
      expect(server.sent.single['content'], '示例问题');
      expect(server.sent.single['mode'], 'followUp');
      expect(server.transcriptions, 1);
      expect(find.text('Bot 正在说话…'), findsOneWidget);
      await tester.tap(find.byTooltip('停止播报'));
      await waitFor(tester, () => audio.recordings == 2);
      await tester.tap(find.byTooltip('静音麦克风'));
      await waitFor(tester, () => find.text('麦克风已静音').evaluate().isNotEmpty);
      expect(audio.recordings, 2);
      await tester.tap(find.byTooltip('取消麦克风静音'));
      await waitFor(tester, () => audio.recordings == 3);
      await tester.tap(find.byTooltip('挂断'));
      await waitFor(tester, () => find.text('1:05').evaluate().isNotEmpty);
      expect(server.ends, 1);
      await tester.tap(find.text('语音通话'));
      await tester.pumpAndSettle();
      expect(find.text('你'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await closeChat(tester, () {
        value.scope.dispose();
        value.session.dispose();
      });
    },
  );

  testWidgets(
    '390px English dictation edits the draft and group never starts a call',
    (tester) async {
      tester.view.physicalSize = const Size(390, 840);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = TestVoiceServer()..group = true;
      final value = await fixture(server.handle);
      final audio = TestVoiceTransport()..denied = true;
      await tester.runAsync(value.scope.refresh);
      await tester.pumpWidget(
        testApp(
          ChatScreen(
            scope: value.scope,
            conversationId: 'chat-a',
            voiceTransport: audio,
          ),
        ),
      );
      final dictate = find.byTooltip('Start dictation');
      await waitFor(tester, () => dictate.evaluate().isNotEmpty);
      expect(find.byTooltip('Start voice chat'), findsNothing);
      await tester.tap(dictate);
      await waitFor(
        tester,
        () => find
            .textContaining('Allow microphone access')
            .evaluate()
            .isNotEmpty,
      );
      expect(audio.recordings, 0);
      expect(server.transcriptions, 0);
      audio.denied = false;
      await tester.enterText(find.byType(TextField), 'Existing draft');
      await tester.pump();
      await tester.tap(dictate);
      await waitFor(tester, () => audio.recordings == 1);
      await tester.tap(find.byTooltip('Finish dictation'));
      await waitFor(tester, () => find.byType(TextField).evaluate().isNotEmpty);
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, 'Existing draft 示例问题');
      expect(server.sent, isEmpty);
      expect(server.starts, 0);
      expect(tester.takeException(), isNull);
      await closeChat(tester, () {
        value.scope.dispose();
        value.session.dispose();
      });
    },
  );

  test(
    'an unknown voice message checks the exact call receipt without resending',
    () async {
      final server = TestVoiceServer()
        ..callId = otherCallId
        ..wrongReceipt = true;
      final value = await fixture(server.handle);
      final chat = ChatController(value.scope, 'chat-a');
      await chat.initialize();
      expect(await chat.send('test', voiceCallId: otherCallId), isFalse);
      expect(chat.pending?['voiceCallId'], otherCallId);
      expect(chat.lastReceipt, isNull);
      await chat.check();
      expect(chat.pending, isNull);
      expect(chat.lastReceipt?['metadata']['voiceCallId'], otherCallId);
      expect(server.sent, hasLength(1));
      chat.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  testWidgets('backgrounding a call stops capture and rejects stale audio', (
    tester,
  ) async {
    final server = TestVoiceServer();
    final value = await fixture(server.handle);
    final audio = TestVoiceTransport();
    await tester.runAsync(value.scope.refresh);
    await tester.pumpWidget(
      testApp(
        ChatScreen(
          scope: value.scope,
          conversationId: 'chat-a',
          voiceTransport: audio,
        ),
      ),
    );
    final button = find.byTooltip('Start voice chat');
    await waitFor(tester, () => button.evaluate().isNotEmpty);
    await tester.tap(button);
    await waitFor(tester, () => audio.recordings == 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await waitFor(tester, () => server.ends == 1);
    expect(audio.stops, 1);
    expect(server.transcriptions, 0);
    expect(server.sent, isEmpty);
    await closeChat(tester, () {
      value.scope.dispose();
      value.session.dispose();
    });
  });

  testWidgets('an uploaded draft file keeps the regular composer controls', (
    tester,
  ) async {
    final server = TestVoiceServer();
    final value = await fixture(server.handle);
    final staged = <String, dynamic>{
      'id': 'staged-file',
      'name': 'Draft file.txt',
      'size': 20,
      'type': 'text/plain',
      'conversationId': 'chat-a',
    };
    server.files.add(staged);
    value.secrets.values[AttachmentStorage(
      value.scope,
      'chat-a',
    ).key] = jsonEncode({
      'version': 1,
      'files': [staged],
    });
    await tester.runAsync(value.scope.refresh);
    await tester.pumpWidget(
      testApp(
        ChatScreen(
          scope: value.scope,
          conversationId: 'chat-a',
          voiceTransport: TestVoiceTransport(),
        ),
      ),
    );
    await waitFor(
      tester,
      () => find.byTooltip('Start dictation').evaluate().isNotEmpty,
    );
    expect(find.byTooltip('Start voice chat'), findsNothing);
    expect(find.byIcon(Icons.arrow_upward), findsOneWidget);
    expect(server.starts, 0);
    await closeChat(tester, () {
      value.scope.dispose();
      value.session.dispose();
    });
  });

  test('PCM validation rejects invalid, mismatched and oversized audio', () {
    final audio = sampleWave();
    expect(validVoiceWave(audio, 60), isTrue);
    expect(validVoiceWave(audio, 0), isFalse);
    audio[24] = 0;
    expect(validVoiceWave(audio, 60), isFalse);
    expect(validVoiceWave(Uint8List(45), 60), isFalse);
  });
}

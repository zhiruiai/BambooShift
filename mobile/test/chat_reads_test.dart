import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_reads.dart';

import 'support.dart';

const renderedChat = {'id': 'chat-a', 'readThrough': 7, 'unread': 3};

void main() {
  test(
    'only the rendered watermark is acknowledged for the captured actor',
    () async {
      Json? sent;
      final value = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.method == 'GET') return jsonResponse(bootstrap());
        expect(request.method, 'PATCH');
        expect(
          request.url.path,
          '/api/workspaces/space-a/conversations/chat-a',
        );
        sent = jsonDecode(request.body) as Json;
        return jsonResponse({});
      });
      value.scope.data = {
        ...bootstrap(),
        'conversations': [
          {...renderedChat, 'readThrough': 10, 'unread': 6},
        ],
      };
      final reads = ChatReads(value.scope, 'chat-a');
      expect(await reads.viewed(renderedChat, () => true), true);
      expect(sent, {'read': true, 'readThrough': 7});
      expect(value.secrets.values, isEmpty);
      reads.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'background, other conversations and malformed cursors cannot mark read',
    () async {
      var requests = 0;
      final value = await fixture((_) async {
        requests++;
        return jsonResponse({});
      });
      final reads = ChatReads(value.scope, 'chat-a');
      expect(await reads.viewed(renderedChat, () => false), false);
      for (final invalid in [
        {...renderedChat, 'id': 'chat-b'},
        {...renderedChat, 'readThrough': -1},
        {...renderedChat, 'readThrough': 9007199254740992},
        {...renderedChat, 'readThrough': 7.5},
        {...renderedChat, 'unread': 0},
        {'id': 'chat-a', 'unread': 2},
      ]) {
        expect(await reads.viewed(invalid, () => true), false);
      }
      expect(requests, 0);
      reads.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'lost acknowledgement is never repeated by a refresh loop; explicit retry is idempotent',
    () async {
      var writes = 0;
      final value = await fixture((_) async {
        writes++;
        throw http.ClientException('Synthetic lost acknowledgement');
      });
      final reads = ChatReads(value.scope, 'chat-a');
      expect(await reads.viewed(renderedChat, () => true), true);
      expect(await reads.viewed(renderedChat, () => true), false);
      expect(writes, 1);
      reads.retry();
      expect(await reads.viewed(renderedChat, () => true), true);
      expect(writes, 2);
      expect(value.secrets.values, isEmpty);
      reads.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'an in-flight acknowledgement cannot consume a later arrival or cross actors',
    () async {
      final reply = Completer<http.Response>(), sent = Completer<void>();
      final writes = <Json>[];
      final value = await fixture((request) async {
        writes.add(jsonDecode(request.body) as Json);
        sent.complete();
        return reply.future;
      });
      final reads = ChatReads(value.scope, 'chat-a');
      final saving = reads.viewed(renderedChat, () => true);
      await sent.future;
      expect(
        await reads.viewed({...renderedChat, 'readThrough': 8}, () => true),
        false,
      );
      value.session.user = {'id': 'user-b'};
      reply.complete(jsonResponse({}));
      await saving;
      expect(writes, [
        {'read': true, 'readThrough': 7},
      ]);
      expect(
        await reads.viewed({...renderedChat, 'readThrough': 9}, () => true),
        false,
      );
      reads.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );
}

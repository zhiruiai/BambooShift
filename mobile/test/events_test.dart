import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/events.dart';
import 'package:openbot_mobile/core/secure_store.dart';

import 'support.dart';

class StreamingClient extends http.BaseClient {
  StreamingClient(this.open);
  final Future<http.StreamedResponse> Function(http.BaseRequest) open;
  bool closed = false;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) => open(request);
  @override
  void close() {
    closed = true;
  }
}

void main() {
  test(
    'SSE split chunks retain Unicode and never issue mutation requests',
    () async {
      late StreamingClient client;
      final payload = utf8.encode(
        'event: message\ndata: {"content":"你好"}\n\nevent: update\ndata: {}\n\n',
      );
      final api = ApiClient(
        SessionVault(MemorySecrets()),
        factory: () {
          client = StreamingClient((request) async {
            expect(request.method, 'GET');
            expect(request.headers['X-OpenBot-Expected-User'], 'actor');
            expect(request.followRedirects, isFalse);
            return http.StreamedResponse(
              Stream.fromIterable(payload.map((byte) => [byte])),
              200,
            );
          });
          return client;
        },
      );
      await api.configure(parseServer('https://example.test'));
      final connection = EventConnection(api);
      final events = await connection
          .listen('/api/workspaces/space/events', 'actor')
          .toList();
      expect(events.map((e) => e['type']), ['message', 'update']);
      expect(events.first['data']['content'], '你好');
      expect(client.closed, isTrue);
      api.dispose();
    },
  );
  test(
    'server change discards a late event before exposing its data',
    () async {
      final stream = StreamController<List<int>>();
      final api = ApiClient(
        SessionVault(MemorySecrets()),
        factory: () => StreamingClient(
          (_) async => http.StreamedResponse(stream.stream, 200),
        ),
      );
      await api.configure(parseServer('https://first.example.test'));
      final connection = EventConnection(api);
      final values = <Json>[];
      final done = connection
          .listen('/api/workspaces/space/events', 'actor')
          .listen(values.add)
          .asFuture<void>();
      final assertion = expectLater(
        done,
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'STALE_SCOPE'),
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await api.configure(parseServer('https://second.example.test'));
      stream.add(
        utf8.encode('event: message\ndata: {"content":"private"}\n\n'),
      );
      await stream.close();
      await assertion;
      expect(values, isEmpty);
      api.dispose();
    },
  );
}

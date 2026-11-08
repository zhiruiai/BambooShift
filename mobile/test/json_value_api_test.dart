import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/core/secure_store.dart';

import 'support.dart';

class PendingJsonClient extends http.BaseClient {
  PendingJsonClient(this.response);
  final Completer<http.StreamedResponse> response;
  var calls = 0;
  var closed = false;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    calls++;
    expect(request.followRedirects, false);
    expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
    return response.future;
  }

  @override
  void close() => closed = true;
}

Matcher errorCode(String code) =>
    isA<ApiException>().having((error) => error.code, 'code', code);

void main() {
  test(
    'shared JSON transport accepts arrays and null; Map API remains strict',
    () async {
      for (final value in [
        <Object?>[
          {'id': 'app-a'},
        ],
        null,
      ]) {
        final api = ApiClient(
          SessionVault(MemorySecrets()),
          factory: () => MockClient((request) async {
            expect(request.url.origin, 'https://api.example.test');
            expect(request.headers['Origin'], request.url.origin);
            return http.Response(jsonEncode(value), 200);
          }),
        );
        await api.configure(parseServer('https://api.example.test'));
        expect(
          await api.requestValue('GET', '/api/workspaces/space-a/apps'),
          value,
        );
        await expectLater(
          api.request('GET', '/api/account/session'),
          throwsA(errorCode('INVALID_RESPONSE')),
        );
        api.dispose();
      }
    },
  );

  test(
    'non-object rejection preserves the HTTP status without retry',
    () async {
      var calls = 0;
      final api = ApiClient(
        SessionVault(MemorySecrets()),
        factory: () => MockClient((_) async {
          calls++;
          return http.Response('null', 403);
        }),
      );
      await api.configure(parseServer('https://api.example.test'));
      await expectLater(
        api.requestValue('POST', '/api/workspaces/space-a/apps'),
        throwsA(
          isA<ApiException>().having((error) => error.status, 'status', 403),
        ),
      );
      expect(calls, 1);
      api.dispose();
    },
  );

  test(
    'workspace change rejects a late cookie without changing generation',
    () async {
      final late = Completer<http.Response>();
      final store = MemorySecrets();
      var current = true;
      final api = ApiClient(
        SessionVault(store),
        factory: () => MockClient((_) => late.future),
      );
      await api.configure(parseServer('https://api.example.test'));
      final pending = api.requestValue(
        'GET',
        '/api/workspaces/space-a/apps',
        expectedUser: 'user-a',
        isCurrent: () => current,
      );
      final assertion = expectLater(pending, throwsA(errorCode('STALE_SCOPE')));
      current = false;
      late.complete(
        http.Response(
          '[]',
          200,
          headers: {'set-cookie': 'openbot_account=${'a' * 43}; Path=/'},
        ),
      );
      await assertion;
      expect(store.values, isEmpty);
      api.dispose();
    },
  );

  test('cancellation releases a pending response and a stalled body', () async {
    for (final lateHeaders in [true, false]) {
      final response = Completer<http.StreamedResponse>();
      var cancelled = false;
      final body = StreamController<List<int>>(
        onCancel: () => cancelled = true,
      );
      final client = PendingJsonClient(response);
      final api = ApiClient(
        SessionVault(MemorySecrets()),
        factory: () => client,
      );
      await api.configure(parseServer('https://api.example.test'));
      final cancel = ByteReadCancellation();
      final pending = api.requestValue(
        'POST',
        '/api/workspaces/space-a/apps',
        expectedUser: 'user-a',
        cancellation: cancel,
      );
      final assertion = expectLater(pending, throwsA(errorCode('STALE_SCOPE')));
      if (!lateHeaders) {
        response.complete(http.StreamedResponse(body.stream, 200));
      }
      await Future<void>.delayed(Duration.zero);
      cancel.cancel();
      await assertion;
      if (lateHeaders) {
        response.complete(http.StreamedResponse(body.stream, 200));
      }
      await Future<void>.delayed(Duration.zero);
      expect(client.closed, true);
      expect(client.calls, 1);
      expect(cancelled, true);
      await body.close();
      api.dispose();
    }
  });

  test(
    'a total deadline closes the transport without resending a write',
    () async {
      final response = Completer<http.StreamedResponse>();
      final client = PendingJsonClient(response);
      final api = ApiClient(
        SessionVault(MemorySecrets()),
        factory: () => client,
      );
      await api.configure(parseServer('https://api.example.test'));
      await expectLater(
        api.requestValue(
          'POST',
          '/api/workspaces/space-a/apps',
          expectedUser: 'user-a',
          timeout: const Duration(milliseconds: 5),
        ),
        throwsA(errorCode('NETWORK_UNKNOWN')),
      );
      response.complete(http.StreamedResponse(const Stream.empty(), 200));
      expect(client.closed, true);
      expect(client.calls, 1);
      api.dispose();
    },
  );
}

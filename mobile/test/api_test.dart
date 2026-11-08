import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/secure_store.dart';

import 'support.dart';

void main() {
  test(
    'server selection only accepts a fixed HTTPS origin or local development',
    () {
      expect(
        parseServer('https://api.example.test/').origin,
        'https://api.example.test',
      );
      expect(parseServer('http://localhost:4319').port, 4319);
      for (final value in [
        'http://api.example.test',
        'https://user:secret@example.test',
        'https://example.test/api',
        'https://example.test/?key=x',
        'file:///private/key',
      ]) {
        expect(() => parseServer(value), throwsA(isA<ApiException>()));
      }
    },
  );
  test(
    'account cookies are securely isolated per server; operator cookies are ignored',
    () async {
      final store = MemorySecrets();
      final requests = <http.Request>[];
      var signIn = true;
      final api = ApiClient(
        SessionVault(store),
        factory: () => MockClient((request) async {
          requests.add(request);
          if (signIn) {
            signIn = false;
            return jsonResponse(
              {'ok': true},
              headers: {
                'set-cookie':
                    'openbot_account=${'a' * 43}; Path=/; HttpOnly, openbot_operator=${'b' * 43}; Path=/; HttpOnly',
              },
            );
          }
          return jsonResponse({'ok': true});
        }),
      );
      await api.configure(parseServer('https://first.example.test'));
      await api.request(
        'POST',
        '/api/account/login',
        body: {
          'email': 'person@example.test',
          'password': 'synthetic-password',
        },
      );
      await api.request('GET', '/api/account/session', expectedUser: 'user-a');
      expect(requests.last.headers['Cookie'], 'openbot_account=${'a' * 43}');
      expect(requests.last.headers['X-OpenBot-Expected-User'], 'user-a');
      expect(requests.last.headers['Origin'], 'https://first.example.test');
      await api.configure(parseServer('https://second.example.test'));
      await api.request('GET', '/api/account/session');
      expect(requests.last.headers['Cookie'], isNull);
      await api.configure(parseServer('https://first.example.test'));
      await api.request('GET', '/api/account/session');
      expect(requests.last.headers['Cookie'], 'openbot_account=${'a' * 43}');
      expect(
        store.values.values.any((value) => value.contains('operator')),
        isFalse,
      );
      api.dispose();
    },
  );
  test(
    'a late login response cannot persist a cookie after server changes',
    () async {
      final late = Completer<http.Response>();
      final store = MemorySecrets();
      final api = ApiClient(
        SessionVault(store),
        factory: () => MockClient((_) => late.future),
      );
      await api.configure(parseServer('https://first.example.test'));
      final result = api.request('POST', '/api/account/login');
      final assertion = expectLater(
        result,
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'STALE_SCOPE'),
        ),
      );
      await api.configure(parseServer('https://second.example.test'));
      late.complete(
        jsonResponse(
          {'ok': true},
          headers: {'set-cookie': 'openbot_account=${'a' * 43}; Path=/'},
        ),
      );
      await assertion;
      expect(store.values, isEmpty);
      api.dispose();
    },
  );
  test('redirects and malformed replies do not get retried', () async {
    var calls = 0;
    final api = ApiClient(
      SessionVault(MemorySecrets()),
      factory: () => MockClient((request) async {
        calls++;
        expect(request.followRedirects, isFalse);
        return http.Response(
          '',
          302,
          headers: {'location': 'https://other.example.test'},
        );
      }),
    );
    await api.configure(parseServer('https://api.example.test'));
    await expectLater(
      api.request('GET', '/api/account/session'),
      throwsA(
        isA<ApiException>().having((e) => e.code, 'code', 'REDIRECT_REJECTED'),
      ),
    );
    expect(calls, 1);
    api.dispose();
    final malformed = ApiClient(
      SessionVault(MemorySecrets()),
      factory: () =>
          MockClient((_) async => http.Response(jsonEncode([]), 200)),
    );
    await malformed.configure(parseServer('https://api.example.test'));
    await expectLater(
      malformed.request('GET', '/api/account/session'),
      throwsA(
        isA<ApiException>().having((e) => e.code, 'code', 'INVALID_RESPONSE'),
      ),
    );
    malformed.dispose();
  });
  test('queued secure writes respect invalidation before they start', () async {
    final store = MemorySecrets();
    final vault = SessionVault(store);
    final barrier = Completer<void>();
    var allowed = true;
    final held = vault.serial(() => barrier.future);
    final write = vault.write(
      'https://example.test',
      'account',
      'token',
      allowed: () => allowed,
    );
    allowed = false;
    barrier.complete();
    await held;
    await write;
    expect(store.values, isEmpty);
  });
}

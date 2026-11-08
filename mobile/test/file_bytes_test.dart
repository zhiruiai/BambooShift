import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/core/secure_store.dart';

import 'support.dart';

class StreamClient extends http.BaseClient {
  StreamClient(this.handler);
  final Future<http.StreamedResponse> Function(http.BaseRequest) handler;
  bool closed = false;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      handler(request);
  @override
  void close() {
    closed = true;
  }
}

const fileHeaders = {
  'content-type': 'text/plain',
  'content-disposition': 'attachment; filename="synthetic.txt"',
};
Future<ApiClient> client(StreamClient transport) async {
  final api = ApiClient(
    SessionVault(MemorySecrets()),
    factory: () => transport,
  );
  await api.configure(parseServer('https://api.example.test'));
  return api;
}

Matcher code(String value) =>
    isA<ApiException>().having((e) => e.code, 'code', value);

void main() {
  test(
    'file reading fixes account, path, origin and refuses caller path injection',
    () async {
      var calls = 0;
      final transport = StreamClient((request) async {
        calls++;
        expect(
          request.url.toString(),
          'https://api.example.test/api/workspaces/space-a/files/file-a/download',
        );
        expect(request.followRedirects, false);
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(request.headers['Origin'], 'https://api.example.test');
        return http.StreamedResponse(
          Stream.value(utf8.encode('Synthetic 中文')),
          200,
          headers: fileHeaders,
        );
      });
      final api = await client(transport);
      final result = await api.readWorkspaceFile(
        'space-a',
        'file-a',
        expectedUser: 'user-a',
        isCurrent: () => true,
        cancellation: ByteReadCancellation(),
      );
      expect(utf8.decode(result.bytes), 'Synthetic 中文');
      expect(transport.closed, true);
      for (final id in [
        '../other',
        'https://other.example.test',
        'file?a=b',
        '',
      ]) {
        await expectLater(
          api.readWorkspaceFile(
            'space-a',
            id,
            expectedUser: 'user-a',
            isCurrent: () => true,
            cancellation: ByteReadCancellation(),
          ),
          throwsA(code('INVALID_PATH')),
        );
      }
      expect(calls, 1);
      api.dispose();
    },
  );
  test(
    'declared and actual overflow cancel streams before publishing any file',
    () async {
      for (final declared in [true, false]) {
        var cancelled = false;
        final body = StreamController<List<int>>(
          onCancel: () {
            cancelled = true;
          },
        );
        body.add(List.filled(20, 65));
        final transport = StreamClient(
          (_) async => http.StreamedResponse(
            body.stream,
            200,
            headers: {...fileHeaders, if (declared) 'content-length': '20'},
          ),
        );
        final api = await client(transport);
        await expectLater(
          api.readWorkspaceFile(
            'space-a',
            'file-a',
            maximum: 10,
            expectedUser: 'user-a',
            isCurrent: () => true,
            cancellation: ByteReadCancellation(),
          ),
          throwsA(code('FILE_TOO_LARGE')),
        );
        expect(cancelled, true);
        expect(transport.closed, true);
        await body.close();
        api.dispose();
      }
    },
  );
  test('redirect and HTML error bodies never become file content', () async {
    for (final status in [302, 403, 500, 200]) {
      final transport = StreamClient(
        (_) async => http.StreamedResponse(
          Stream.value(utf8.encode('<html>secret error</html>')),
          status,
          headers: {
            'content-type': 'text/html',
            'location': 'https://other.example.test',
          },
        ),
      );
      final api = await client(transport);
      await expectLater(
        api.readWorkspaceFile(
          'space-a',
          'file-a',
          expectedUser: 'user-a',
          isCurrent: () => true,
          cancellation: ByteReadCancellation(),
        ),
        throwsA(isA<ApiException>()),
      );
      expect(transport.closed, true);
      api.dispose();
    }
  });
  test(
    'actor changes cancel a late response body and expose no bytes',
    () async {
      var current = true, cancelled = false;
      final response = Completer<http.StreamedResponse>();
      final transport = StreamClient((_) => response.future);
      final api = await client(transport);
      final pending = api.readWorkspaceFile(
        'space-a',
        'file-a',
        expectedUser: 'user-a',
        isCurrent: () => current,
        cancellation: ByteReadCancellation(),
      );
      final assertion = expectLater(pending, throwsA(code('STALE_SCOPE')));
      current = false;
      final body = StreamController<List<int>>(
        onCancel: () {
          cancelled = true;
        },
      );
      response.complete(
        http.StreamedResponse(body.stream, 200, headers: fileHeaders),
      );
      await assertion;
      expect(cancelled, true);
      await body.close();
      api.dispose();
    },
  );
  test(
    'explicit close cancels a stalled stream and a response arriving after close',
    () async {
      for (final lateHeader in [false, true]) {
        var cancelled = false;
        final response = Completer<http.StreamedResponse>();
        final body = StreamController<List<int>>(
          onCancel: () {
            cancelled = true;
          },
        );
        final transport = StreamClient((_) => response.future);
        final api = await client(transport);
        final cancel = ByteReadCancellation();
        final pending = api.readWorkspaceFile(
          'space-a',
          'file-a',
          expectedUser: 'user-a',
          isCurrent: () => true,
          cancellation: cancel,
        );
        final assertion = expectLater(pending, throwsA(code('STALE_SCOPE')));
        if (!lateHeader) {
          response.complete(
            http.StreamedResponse(body.stream, 200, headers: fileHeaders),
          );
        }
        await Future<void>.delayed(Duration.zero);
        cancel.cancel();
        await assertion;
        if (lateHeader) {
          response.complete(
            http.StreamedResponse(body.stream, 200, headers: fileHeaders),
          );
        }
        await Future<void>.delayed(Duration.zero);
        expect(cancelled, true);
        expect(transport.closed, true);
        await body.close();
        api.dispose();
      }
    },
  );
  test('total deadline terminates a pending response without retry', () async {
    var calls = 0;
    final response = Completer<http.StreamedResponse>();
    final transport = StreamClient((_) {
      calls++;
      return response.future;
    });
    final api = await client(transport);
    await expectLater(
      api.readWorkspaceFile(
        'space-a',
        'file-a',
        expectedUser: 'user-a',
        isCurrent: () => true,
        cancellation: ByteReadCancellation(),
        timeout: const Duration(milliseconds: 5),
      ),
      throwsA(code('READ_TIMEOUT')),
    );
    response.complete(
      http.StreamedResponse(const Stream.empty(), 200, headers: fileHeaders),
    );
    expect(calls, 1);
    expect(transport.closed, true);
    api.dispose();
  });
}

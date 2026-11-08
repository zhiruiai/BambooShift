import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';

import 'file_bytes_test.dart' show StreamClient, client, code, fileHeaders;

void main() {
  test(
    'explicit download accepts a document larger than the preview limit',
    () async {
      final bytes = List<int>.filled(3 * 1024 * 1024, 42);
      final transport = StreamClient((request) async {
        expect(
          request.url.path,
          '/api/workspaces/space-a/files/document-a/download',
        );
        expect(request.followRedirects, false);
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        return http.StreamedResponse(
          Stream.value(bytes),
          200,
          headers: {
            ...fileHeaders,
            'content-type': 'application/pdf',
            'content-length': '${bytes.length}',
          },
        );
      });
      final api = await client(transport);
      final result = await api.downloadWorkspaceFile(
        'space-a',
        'document-a',
        expectedUser: 'user-a',
        isCurrent: () => true,
        cancellation: ByteReadCancellation(),
      );
      expect(result.bytes.length, bytes.length);
      expect(result.mimeType, 'application/pdf');
      expect(transport.closed, true);
      api.dispose();
    },
  );

  test(
    'download is bounded to ten MiB even if the response omits its size',
    () async {
      for (final declared in [true, false]) {
        var cancelled = false;
        final stream = StreamController<List<int>>(
          onCancel: () {
            cancelled = true;
          },
        );
        stream.add(List<int>.filled(10 * 1024 * 1024 + 1, 42));
        final transport = StreamClient(
          (_) async => http.StreamedResponse(
            stream.stream,
            200,
            headers: {
              ...fileHeaders,
              if (declared) 'content-length': '${10 * 1024 * 1024 + 1}',
            },
          ),
        );
        final api = await client(transport);
        await expectLater(
          api.downloadWorkspaceFile(
            'space-a',
            'file-a',
            expectedUser: 'user-a',
            isCurrent: () => true,
            cancellation: ByteReadCancellation(),
          ),
          throwsA(code('FILE_TOO_LARGE')),
        );
        expect(cancelled, true);
        expect(transport.closed, true);
        await stream.close();
        api.dispose();
      }
    },
  );

  test(
    'download never follows redirects or releases bytes after actor switch',
    () async {
      final redirect = StreamClient(
        (_) async => http.StreamedResponse(
          Stream.value([42]),
          302,
          headers: {
            ...fileHeaders,
            'location': 'https://untrusted.example.test/private.pdf',
          },
        ),
      );
      final api = await client(redirect);
      await expectLater(
        api.downloadWorkspaceFile(
          'space-a',
          'file-a',
          expectedUser: 'user-a',
          isCurrent: () => true,
          cancellation: ByteReadCancellation(),
        ),
        throwsA(isA<ApiException>()),
      );
      expect(redirect.closed, true);
      api.dispose();
      var current = true;
      final response = Completer<http.StreamedResponse>();
      final transport = StreamClient((_) => response.future);
      final scoped = await client(transport);
      final pending = scoped.downloadWorkspaceFile(
        'space-a',
        'file-a',
        expectedUser: 'user-a',
        isCurrent: () => current,
        cancellation: ByteReadCancellation(),
      );
      final assertion = expectLater(pending, throwsA(code('STALE_SCOPE')));
      current = false;
      response.complete(
        http.StreamedResponse(Stream.value([42]), 200, headers: fileHeaders),
      );
      await assertion;
      expect(transport.closed, true);
      scoped.dispose();
    },
  );

  test('preview callers cannot increase their two MiB allowance', () async {
    var calls = 0;
    final transport = StreamClient((_) async {
      calls++;
      return http.StreamedResponse(
        const Stream.empty(),
        200,
        headers: fileHeaders,
      );
    });
    final api = await client(transport);
    await expectLater(
      api.readWorkspaceFile(
        'space-a',
        'file-a',
        maximum: 3 * 1024 * 1024,
        expectedUser: 'user-a',
        isCurrent: () => true,
        cancellation: ByteReadCancellation(),
      ),
      throwsA(code('INVALID_PATH')),
    );
    expect(calls, 0);
    api.dispose();
  });
}

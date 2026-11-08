import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/core/secure_store.dart';

import 'support.dart';

class ScreenshotClient extends http.BaseClient {
  ScreenshotClient(this.handle);
  final Future<http.StreamedResponse> Function(http.BaseRequest) handle;
  bool closed = false;
  int calls = 0;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    calls++;
    return handle(request);
  }

  @override
  void close() {
    closed = true;
  }
}

final png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO7cAAAAASUVORK5CYII=',
);
const headers = {
  'content-type': 'image/png',
  'cache-control': 'private, no-store',
  'x-frame-width': '1',
  'x-frame-height': '1',
  'x-computer-surface': 'browser',
  'x-captured-at': '2026-11-07T00:00:00Z',
};
Matcher code(String value) =>
    isA<ApiException>().having((e) => e.code, 'code', value);

Future<ApiClient> configured(ScreenshotClient transport) async {
  final api = ApiClient(
    SessionVault(MemorySecrets()),
    factory: () => transport,
  );
  await api.configure(parseServer('https://api.example.test'));
  return api;
}

Future<ComputerScreenshotBytes> read(
  ApiClient api, {
  bool Function()? current,
  ByteReadCancellation? cancellation,
  String? leaseId,
}) => api.readComputerScreenshot(
  'space-a',
  'bot-a',
  expectedUser: 'user-a',
  isCurrent: current ?? () => true,
  cancellation: cancellation ?? ByteReadCancellation(),
  leaseId: leaseId,
);

void main() {
  test(
    'screenshot reads a fixed Bot path and validates original frame dimensions',
    () async {
      final transport = ScreenshotClient((request) async {
        expect(
          request.url.path,
          '/api/workspaces/space-a/computer/bots/bot-a/screenshot',
        );
        expect(request.url.origin, 'https://api.example.test');
        expect(request.followRedirects, false);
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(request.headers['Origin'], request.url.origin);
        expect(request.headers['Cache-Control'], 'no-store');
        return http.StreamedResponse(Stream.value(png), 200, headers: headers);
      });
      final api = await configured(transport);
      final frame = await read(api);
      expect(frame.width, 1);
      expect(frame.height, 1);
      expect(frame.surface, 'browser');
      expect(frame.bytes, png);
      expect(transport.closed, true);
      await expectLater(
        api.readComputerScreenshot(
          'space-a',
          '../other',
          expectedUser: 'user-a',
          isCurrent: () => true,
          cancellation: ByteReadCancellation(),
        ),
        throwsA(code('INVALID_PATH')),
      );
      expect(transport.calls, 1);
      api.dispose();
    },
  );

  test(
    'private capture uses only the dedicated authenticated no-store POST',
    () async {
      final privateHeaders = {
        ...headers,
        'x-openbot-frame-visibility': 'takeover',
      };
      final transport = ScreenshotClient((request) async {
        expect(request.method, 'POST');
        expect(request.followRedirects, false);
        expect(
          request.url.path,
          '/api/workspaces/space-a/computer/bots/bot-a/takeover/screenshot',
        );
        expect(request.url.query, isEmpty);
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(request.headers['X-OpenBot-Computer-Lease'], 'lease-original');
        expect(request.headers['Cache-Control'], 'no-store');
        expect((request as http.Request).body, '{}');
        return http.StreamedResponse(
          Stream.value(png),
          200,
          headers: privateHeaders,
        );
      });
      final api = await configured(transport);
      final capture = await read(api, leaseId: 'lease-original');
      expect(capture.isPrivate, true);
      expect(capture.surface, 'browser');
      expect(capture.bytes, png);
      await expectLater(
        read(api, leaseId: 'other\nlease'),
        throwsA(code('INVALID_PATH')),
      );
      expect(transport.calls, 1);
      api.dispose();
    },
  );

  test('private and shared screenshots cannot be interchanged', () async {
    for (final test in [
      (
        lease: 'lease-original',
        visibility: 'shared',
        cache: 'private, no-store',
        surface: 'browser',
      ),
      (
        lease: 'lease-original',
        visibility: 'takeover',
        cache: 'no-store',
        surface: 'browser',
      ),
      (
        lease: 'lease-original',
        visibility: 'takeover',
        cache: 'private, no-store',
        surface: 'unknown',
      ),
      (
        lease: null,
        visibility: 'takeover',
        cache: 'private, no-store',
        surface: 'browser',
      ),
    ]) {
      final transport = ScreenshotClient(
        (_) async => http.StreamedResponse(
          Stream.value(png),
          200,
          headers: {
            ...headers,
            'x-openbot-frame-visibility': test.visibility,
            'cache-control': test.cache,
            'x-computer-surface': test.surface,
          },
        ),
      );
      final api = await configured(transport);
      await expectLater(
        read(api, leaseId: test.lease),
        throwsA(code('INVALID_FRAME')),
      );
      expect(transport.closed, true);
      api.dispose();
    }
  });

  test(
    'HTML, cached responses, wrong dimensions and excessive pixels never become images',
    () async {
      for (final variant in [
        'html',
        'cached',
        'mismatch',
        'pixels',
        'invalid-png',
      ]) {
        final body = Uint8List.fromList(png);
        final metadata = {...headers};
        if (variant == 'html') metadata['content-type'] = 'text/html';
        if (variant == 'cached') metadata['cache-control'] = 'max-age=60';
        if (variant == 'mismatch') metadata['x-frame-width'] = '2';
        if (variant == 'pixels') {
          ByteData.sublistView(body).setUint32(16, 8193);
          metadata['x-frame-width'] = '8193';
        }
        if (variant == 'invalid-png') body[0] = 0;
        final transport = ScreenshotClient(
          (_) async =>
              http.StreamedResponse(Stream.value(body), 200, headers: metadata),
        );
        final api = await configured(transport);
        await expectLater(read(api), throwsA(code('INVALID_FRAME')));
        expect(transport.closed, true);
        api.dispose();
      }
    },
  );

  test(
    'oversized and redirect responses are cancelled before image decoding',
    () async {
      for (final redirect in [true, false]) {
        var cancelled = false;
        final body = StreamController<List<int>>(
          onCancel: () => cancelled = true,
        );
        final transport = ScreenshotClient(
          (_) async => http.StreamedResponse(
            body.stream,
            redirect ? 302 : 200,
            headers: {...headers, 'content-length': '${10 * 1024 * 1024 + 1}'},
          ),
        );
        final api = await configured(transport);
        await expectLater(
          read(api),
          throwsA(code(redirect ? 'FILE_REJECTED' : 'FILE_TOO_LARGE')),
        );
        expect(cancelled, true);
        expect(transport.closed, true);
        await body.close();
        api.dispose();
      }
    },
  );

  test(
    'scope changes and explicit cancellation release stalled screenshot streams',
    () async {
      for (final cancelExplicitly in [true, false]) {
        var cancelled = false, current = true;
        final body = StreamController<List<int>>(
          onCancel: () => cancelled = true,
        );
        final transport = ScreenshotClient(
          (_) async =>
              http.StreamedResponse(body.stream, 200, headers: headers),
        );
        final api = await configured(transport);
        final cancel = ByteReadCancellation();
        final result = read(api, current: () => current, cancellation: cancel);
        final assertion = expectLater(result, throwsA(code('STALE_SCOPE')));
        await Future<void>.delayed(Duration.zero);
        if (cancelExplicitly) {
          cancel.cancel();
        } else {
          current = false;
          body.add(png);
        }
        await assertion;
        expect(cancelled, true);
        expect(transport.closed, true);
        await body.close();
        api.dispose();
      }
    },
  );
}

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'secure_store.dart';
import 'request_ids.dart';
import 'byte_read.dart';
import 'binary_transport.dart';

export 'workspace_file_bytes.dart' show WorkspaceFileBytes;

typedef Json = Map<String, dynamic>;

class ApiException implements Exception {
  const ApiException(this.code, this.message, [this.status = 0]);
  final String code;
  final String message;
  final int status;
  @override
  String toString() => message;
}

Uri parseServer(String value) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null ||
      !uri.hasAuthority ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/') ||
      (uri.scheme != 'https' &&
          !(uri.scheme == 'http' &&
              ['localhost', '127.0.0.1', '::1'].contains(uri.host)))) {
    throw const ApiException('INVALID_SERVER', 'serverInvalid');
  }
  return Uri.parse(uri.origin);
}

class ApiClient {
  ApiClient(this.vault, {http.Client Function()? factory})
    : _factory = factory ?? (() => http.Client());
  final SessionVault vault;
  final http.Client Function() _factory;
  final Set<http.Client> _clients = {};
  Uri? server;
  String language = 'zh-CN';
  String? _cookie;
  int generation = 0;

  void invalidate() {
    generation++;
    for (final client in _clients.toList()) {
      client.close();
    }
    _clients.clear();
  }

  Future<void> configure(Uri origin) async {
    invalidate();
    server = origin;
    _cookie = null;
    final stamp = generation;
    final saved = await vault.read(origin.origin, 'account');
    guard(stamp);
    if (saved != null &&
        RegExp(
          r'^(?:__Host-)?openbot_account=[A-Za-z0-9_-]{43}$',
        ).hasMatch(saved)) {
      _cookie = saved;
    }
  }

  void guard(int stamp) {
    if (stamp != generation || server == null) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  Map<String, String> headers({String? expectedUser}) => {
    'Accept': 'application/json',
    'Accept-Language': language,
    'Origin': server!.origin,
    'Cookie': ?_cookie,
    'X-OpenBot-Expected-User': ?expectedUser,
  };

  Uri resolve(String path) {
    if (server == null ||
        !path.startsWith('/api/') ||
        path.startsWith('//') ||
        Uri.parse(path).hasAuthority ||
        path.contains('#')) {
      throw const ApiException('INVALID_PATH', 'requestFailed');
    }
    final resolved = server!.resolve(path);
    if (resolved.origin != server!.origin ||
        !resolved.path.startsWith('/api/')) {
      throw const ApiException('INVALID_PATH', 'requestFailed');
    }
    return resolved;
  }

  Future<void> _acceptCookie(
    String? value,
    int stamp,
    String origin, {
    bool Function()? isCurrent,
  }) async {
    bool allowed() => generation == stamp && (isCurrent?.call() ?? true);
    void check() {
      guard(stamp);
      if (!allowed()) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }

    check();
    if (value == null) return;
    final match = RegExp(
      r'(?:^|,\s*)((?:__Host-)?openbot_account)=([^;,]*)',
    ).firstMatch(value);
    if (match == null) return;
    final token = match[2]!;
    if (token.isNotEmpty && !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(token)) {
      throw const ApiException('INVALID_SESSION', 'requestFailed');
    }
    check();
    final cookie = token.isEmpty ? null : '${match[1]}=$token';
    if (cookie == null) {
      await vault.serial(() async {
        if (allowed()) {
          await vault.store.delete(vault.key(origin, 'account'));
        }
      });
    } else {
      await vault.write(origin, 'account', cookie, allowed: allowed);
    }
    check();
    _cookie = cookie;
  }

  Future<Json> request(
    String method,
    String path, {
    Json? body,
    String? expectedUser,
    Duration timeout = const Duration(seconds: 35),
  }) async {
    final value = await requestValue(
      method,
      path,
      body: body,
      expectedUser: expectedUser,
      timeout: timeout,
    );
    if (value is! Json) {
      throw const ApiException('INVALID_RESPONSE', 'requestFailed');
    }
    return value;
  }

  Future<Object?> requestValue(
    String method,
    String path, {
    Json? body,
    Uint8List? rawBody,
    String? rawContentType,
    String? voiceCallId,
    String? expectedUser,
    bool Function()? isCurrent,
    ByteReadCancellation? cancellation,
    Duration timeout = const Duration(seconds: 35),
  }) async {
    if ((voiceCallId != null &&
            (!isRequestId(voiceCallId) ||
                rawContentType != 'audio/wav' ||
                expectedUser == null)) ||
        (rawBody == null) != (rawContentType == null) ||
        (rawBody != null &&
            (body != null ||
                method != 'POST' ||
                rawBody.isEmpty ||
                rawBody.length >= 25 * 1024 * 1024 ||
                ![
                  'image/png',
                  'image/jpeg',
                  'image/webp',
                  'audio/wav',
                ].contains(rawContentType)))) {
      throw const ApiException('INVALID_UPLOAD', 'requestFailed');
    }
    final stamp = generation;
    final uri = resolve(path);
    void check() {
      guard(stamp);
      if (!(isCurrent?.call() ?? true) || (cancellation?.cancelled ?? false)) {
        throw const ApiException('STALE_SCOPE', 'scopeChanged');
      }
    }

    check();
    final client = eventClient();
    StreamIterator<List<int>>? stream;
    http.StreamedResponse? received;
    var finished = false;
    final timedOut = Completer<void>();
    final timer = Timer(timeout, () => timedOut.complete());
    Future<T> wait<T>(Future<T> work) => Future.any([
      work,
      if (cancellation != null)
        cancellation.whenCancelled.then<T>(
          (_) => throw const ApiException('STALE_SCOPE', 'scopeChanged'),
        ),
      timedOut.future.then<T>(
        (_) => throw const ApiException('NETWORK_UNKNOWN', 'requestUnknown'),
      ),
    ]);
    try {
      final request = http.Request(method, uri)..followRedirects = false;
      request.headers.addAll(headers(expectedUser: expectedUser));
      if (voiceCallId != null) {
        request.headers['X-OpenBot-Voice-Call'] = voiceCallId;
      }
      if (body != null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(body);
      }
      if (rawBody != null) {
        request.headers['Content-Type'] = rawContentType!;
        request.bodyBytes = Uint8List.fromList(rawBody);
      }
      check();
      final pending = client.send(request).then((response) {
        if (finished) {
          unawaited(response.stream.listen((_) {}).cancel());
        } else {
          received = response;
        }
        return response;
      });
      final response = await wait(pending);
      check();
      if (response.statusCode >= 300 && response.statusCode < 400) {
        throw const ApiException('REDIRECT_REJECTED', 'requestFailed');
      }
      final bytes = BytesBuilder(copy: false);
      final reader = stream = StreamIterator(response.stream);
      await wait(() async {
        while (await reader.moveNext()) {
          check();
          if (bytes.length + reader.current.length > 16 * 1024 * 1024) {
            throw const ApiException('RESPONSE_TOO_LARGE', 'requestFailed');
          }
          bytes.add(reader.current);
        }
      }());
      check();
      final decoded = bytes.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(utf8.decode(bytes.takeBytes()));
      if (response.statusCode >= 400) {
        throw ApiException(
          decoded is Json && decoded['code'] is String
              ? decoded['code'] as String
              : 'REQUEST_FAILED',
          decoded is Json && decoded['error'] is String
              ? decoded['error'] as String
              : 'requestFailed',
          response.statusCode,
        );
      }
      await _acceptCookie(
        response.headers['set-cookie'],
        stamp,
        uri.origin,
        isCurrent: () =>
            (isCurrent?.call() ?? true) && !(cancellation?.cancelled ?? false),
      );
      check();
      return decoded;
    } on TimeoutException {
      check();
      throw const ApiException('NETWORK_UNKNOWN', 'requestUnknown');
    } on http.ClientException {
      check();
      throw const ApiException('NETWORK_UNKNOWN', 'requestUnknown');
    } on FormatException {
      check();
      throw const ApiException('INVALID_RESPONSE', 'requestFailed');
    } finally {
      finished = true;
      timer.cancel();
      release(client);
      if (stream != null) {
        await stream.cancel();
      } else if (received != null) {
        await received!.stream.listen((_) {}).cancel();
      }
    }
  }

  Future<void> clearSession() async {
    final origin = server?.origin;
    invalidate();
    _cookie = null;
    if (origin != null) await vault.delete(origin, 'account');
  }

  Future<ComputerScreenshotBytes> readComputerScreenshot(
    String workspaceId,
    String agentId, {
    required String expectedUser,
    required bool Function() isCurrent,
    required ByteReadCancellation cancellation,
    Duration timeout = const Duration(seconds: 20),
    String? leaseId,
  }) async {
    final identifier = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
    if (![workspaceId, agentId, expectedUser].every(identifier.hasMatch) ||
        (leaseId != null &&
            !RegExp(r'^[A-Za-z0-9_-]{1,199}$').hasMatch(leaseId))) {
      throw const ApiException(
        'INVALID_PATH',
        'mobileComputerFrameUnavailable',
      );
    }
    final stamp = generation;
    final result = await readBoundedBinary(
      this,
      '/api/workspaces/$workspaceId/computer/bots/$agentId/${leaseId == null ? '' : 'takeover/'}screenshot',
      post: leaseId == null
          ? null
          : (headers: {'X-OpenBot-Computer-Lease': leaseId}, body: {}),
      expectedUser: expectedUser,
      isCurrent: isCurrent,
      cancellation: cancellation,
      maximum: 10 * 1024 * 1024,
      timeout: timeout,
      accept: 'image/png',
      unavailable: leaseId == null
          ? 'mobileComputerFrameUnavailable'
          : 'mobileComputerPrivateUnavailable',
      failed: 'mobileComputerFrameFailed',
      tooLarge: 'mobileComputerFrameTooLarge',
      validateHeaders: (headers) {
        final visibility = headers['x-openbot-frame-visibility'];
        final cache = (headers['cache-control'] ?? '')
            .toLowerCase()
            .split(',')
            .map((s) => s.trim())
            .toSet();
        final validVisibility = leaseId == null
            ? visibility == null || visibility == 'shared'
            : visibility == 'takeover' && cache.contains('private');
        if ((headers['content-type'] ?? '')
                    .split(';')
                    .first
                    .trim()
                    .toLowerCase() !=
                'image/png' ||
            !cache.contains('no-store') ||
            !validVisibility) {
          throw const ApiException(
            'INVALID_FRAME',
            'mobileComputerFrameFailed',
          );
        }
      },
    );
    final bytes = result.bytes;
    try {
      guard(stamp);
      if (!isCurrent() || cancellation.cancelled) {
        throw const ApiException('STALE_SCOPE', 'scopeChanged');
      }
      final signature = [
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
        0,
        0,
        0,
        13,
        73,
        72,
        68,
        82,
      ];
      if (bytes.length < 33 ||
          !List.generate(
            signature.length,
            (i) => bytes[i] == signature[i],
          ).every((v) => v)) {
        throw const ApiException('INVALID_FRAME', 'mobileComputerFrameFailed');
      }
      final header = ByteData.sublistView(bytes);
      final width = header.getUint32(16), height = header.getUint32(20);
      if (width < 1 ||
          height < 1 ||
          width > 8192 ||
          height > 8192 ||
          width * height > 40000000 ||
          int.tryParse(result.headers['x-frame-width'] ?? '') != width ||
          int.tryParse(result.headers['x-frame-height'] ?? '') != height) {
        throw const ApiException('INVALID_FRAME', 'mobileComputerFrameFailed');
      }
      final surface = result.headers['x-computer-surface'];
      final capturedAt = result.headers['x-captured-at'];
      if ((surface != null &&
              !RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(surface)) ||
          (capturedAt != null &&
              (capturedAt.length > 64 ||
                  DateTime.tryParse(capturedAt) == null)) ||
          (leaseId != null && !['browser', 'desktop'].contains(surface))) {
        throw const ApiException('INVALID_FRAME', 'mobileComputerFrameFailed');
      }
      return ComputerScreenshotBytes(
        bytes,
        width,
        height,
        surface: surface,
        capturedAt: capturedAt,
        isPrivate: leaseId != null,
      );
    } catch (_) {
      if (leaseId != null) bytes.fillRange(0, bytes.length, 0);
      rethrow;
    }
  }

  http.Client eventClient() {
    final client = _factory();
    _clients.add(client);
    return client;
  }

  void release(http.Client client) {
    client.close();
    _clients.remove(client);
  }

  void dispose() => invalidate();
}

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'api.dart';
import 'byte_read.dart';

class BinaryReadResult {
  const BinaryReadResult(this.bytes, this.headers);
  final Uint8List bytes;
  final Map<String, String> headers;
}

Future<BinaryReadResult> readBoundedBinary(
  ApiClient api,
  String path, {
  required String expectedUser,
  required bool Function() isCurrent,
  required ByteReadCancellation cancellation,
  required int maximum,
  required void Function(Map<String, String>) validateHeaders,
  Duration timeout = const Duration(seconds: 20),
  String accept = '*/*',
  String unavailable = 'mobileChatFileUnavailable',
  String failed = 'mobileChatFileFailed',
  String tooLarge = 'mobileChatFileTooLarge',
  ({Map<String, String> headers, Json body})? post,
}) async {
  final stamp = api.generation;
  void check() {
    api.guard(stamp);
    if (!isCurrent() || cancellation.cancelled) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  check();
  final uri = api.resolve(path);
  final client = api.eventClient();
  StreamIterator<List<int>>? stream;
  http.StreamedResponse? received;
  var finished = false;
  final output = BytesBuilder(copy: post != null);
  final timedOut = Completer<void>();
  final timer = Timer(timeout, () => timedOut.complete());
  Future<T> wait<T>(Future<T> work) => Future.any([
    work,
    cancellation.whenCancelled.then<T>(
      (_) => throw const ApiException('STALE_SCOPE', 'scopeChanged'),
    ),
    timedOut.future.then<T>((_) => throw ApiException('READ_TIMEOUT', failed)),
  ]);
  try {
    final request = http.Request(post == null ? 'GET' : 'POST', uri)
      ..followRedirects = false;
    if (post != null) {
      request.headers.addAll(post.headers);
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(post.body);
    }
    request.headers.addAll(api.headers(expectedUser: expectedUser));
    request.headers['Accept'] = accept;
    request.headers['Cache-Control'] = 'no-store';
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
    if (response.statusCode != 200) {
      throw ApiException('FILE_REJECTED', unavailable, response.statusCode);
    }
    final declared = response.headers['content-length'];
    final size = declared == null ? null : int.tryParse(declared);
    if (declared != null && (size == null || size < 0 || size > maximum)) {
      throw ApiException('FILE_TOO_LARGE', tooLarge);
    }
    validateHeaders(response.headers);
    final reader = stream = StreamIterator(response.stream);
    await wait(() async {
      while (await reader.moveNext()) {
        check();
        if (output.length + reader.current.length > maximum) {
          throw ApiException('FILE_TOO_LARGE', tooLarge);
        }
        output.add(reader.current);
      }
    }());
    check();
    if (size != null && size != output.length) {
      throw ApiException('INVALID_FILE', failed);
    }
    return BinaryReadResult(
      output.takeBytes(),
      Map.unmodifiable(response.headers),
    );
  } on http.ClientException {
    check();
    throw ApiException('FILE_FAILED', failed);
  } finally {
    finished = true;
    if (post != null && output.isNotEmpty) {
      final rejected = output.takeBytes();
      rejected.fillRange(0, rejected.length, 0);
    }
    timer.cancel();
    api.release(client);
    if (stream != null) {
      await stream.cancel();
    } else if (received != null) {
      await received!.stream.listen((_) {}).cancel();
    }
  }
}

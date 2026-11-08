import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api.dart';

class EventConnection {
  EventConnection(this.api);
  final ApiClient api;
  http.Client? _client;
  bool _closed = false;

  Stream<Json> listen(String path, String userId) async* {
    final stamp = api.generation;
    final client = api.eventClient();
    _client = client;
    final request = http.Request('GET', api.resolve(path))
      ..followRedirects = false;
    request.headers.addAll(api.headers(expectedUser: userId));
    request.headers['Accept'] = 'text/event-stream';
    try {
      final response = await client
          .send(request)
          .timeout(const Duration(seconds: 20));
      api.guard(stamp);
      if (response.statusCode != 200) {
        throw ApiException(
          'EVENTS_UNAVAILABLE',
          'requestFailed',
          response.statusCode,
        );
      }
      var event = 'message';
      final data = <String>[];
      var size = 0;
      await for (final line in _lines(
        response.stream,
      ).timeout(const Duration(seconds: 45))) {
        api.guard(stamp);
        if (_closed) return;
        if (line.length + size > 1024 * 1024) {
          throw const ApiException('EVENT_TOO_LARGE', 'requestFailed');
        }
        if (line.isEmpty) {
          if (data.isNotEmpty) {
            final decoded = jsonDecode(data.join('\n'));
            yield {'type': event, 'data': decoded};
          }
          data.clear();
          size = 0;
          event = 'message';
        } else if (line.startsWith('event:')) {
          event = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          final value = line.substring(5).trimLeft();
          data.add(value);
          size += value.length;
        }
      }
    } finally {
      api.release(client);
      if (identical(_client, client)) _client = null;
    }
  }

  Stream<String> _lines(Stream<List<int>> stream) async* {
    var pending = '';
    await for (final chunk in stream.transform(utf8.decoder)) {
      if (_closed) return;
      pending += chunk;
      if (pending.length > 1024 * 1024) {
        throw const ApiException('EVENT_TOO_LARGE', 'requestFailed');
      }
      int end;
      while ((end = pending.indexOf('\n')) >= 0) {
        final line = pending.substring(0, end);
        pending = pending.substring(end + 1);
        yield line.endsWith('\r') ? line.substring(0, line.length - 1) : line;
      }
    }
  }

  void close() {
    _closed = true;
    final client = _client;
    if (client != null) api.release(client);
    _client = null;
  }
}

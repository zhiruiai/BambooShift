import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/attachment_selection.dart';

import 'support.dart';

SelectedAttachment selectedFile({
  String name = 'note.txt',
  List<int>? bytes,
  int? size,
  void Function()? onRead,
}) {
  final content = bytes ?? utf8.encode('Synthetic selected document');
  return SelectedAttachment(
    name: name,
    size: size ?? content.length,
    type: 'text/plain',
    openRead: () {
      onRead?.call();
      return Stream.value(Uint8List.fromList(content));
    },
  );
}

class AttachmentServer {
  final files = <Json>[], messages = <Json>[], requests = <http.Request>[];
  bool loseUpload = false, acceptUpload = true, failRead = false;
  String? lastContent;
  Future<http.Response> handle(http.Request r) async {
    requests.add(r);
    if (r.url.path.endsWith('/bootstrap')) {
      if (failRead) return jsonResponse({'error': 'unavailable'}, status: 503);
      return jsonResponse({
        ...bootstrap(
          messages: messages,
          agents: [
            {
              'id': 'bot-a',
              'name': 'Example Bot',
              'avatar': 'orb',
              'color': '#111111',
              'status': 'idle',
            },
          ],
        ),
        'settings': {'configured': true},
        'files': files,
      });
    }
    if (r.url.path.endsWith('/files') && r.method == 'POST') {
      final body = jsonDecode(r.body) as Json;
      lastContent = body['content'];
      final file = <String, dynamic>{
        'id': 'file-${files.length + 1}',
        'name': body['name'],
        'size': base64Decode(body['content']).length,
        'type': body['type'],
        'conversationId': body['conversationId'],
        'createdAt': '2026-11-07T00:00:00Z',
      };
      if (acceptUpload) {
        files.add(file);
        messages.add({
          'id': 'message-${files.length}',
          'role': 'user',
          'kind': 'file',
          'userId': 'user-a',
          'conversationId': 'chat-a',
          'content': body['name'],
          'metadata': {'fileId': file['id'], 'size': file['size']},
        });
      }
      if (loseUpload) throw http.ClientException('Synthetic lost response');
      return jsonResponse(file, status: 201);
    }
    if (r.url.path.endsWith('/messages')) {
      final body = jsonDecode(r.body) as Json;
      final message = <String, dynamic>{
        'id': 'sent-message',
        'conversationId': 'chat-a',
        'role': 'user',
        'kind': 'text',
        'userId': 'user-a',
        'content': body['content'],
        'delivery': {'clientId': body['clientId']},
      };
      messages.add(message);
      return jsonResponse({'message': message});
    }
    return jsonResponse({'error': 'Unexpected path'}, status: 404);
  }
}

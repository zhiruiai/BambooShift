import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/app_session.dart';
import 'package:openbot_mobile/core/secure_store.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';

class MemorySecrets implements SecretStore {
  final Map<String, String> values = {};
  bool rejectWrites = false;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    if (rejectWrites) throw StateError('Storage unavailable');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

http.Response jsonResponse(
  Object value, {
  int status = 200,
  Map<String, String>? headers,
}) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json', ...?headers},
);
Json bootstrap({
  List<Json> messages = const [],
  List<Json> agents = const [],
}) => {
  'agents': agents,
  'conversations': [
    {
      'id': 'chat-a',
      'title': 'Example',
      'agentIds': ['bot-a'],
      'isGroup': false,
    },
  ],
  'messages': messages,
  'sync': {'epoch': 'epoch', 'revision': 1},
  'settings': {'configured': false},
};
Future<({AppSession session, WorkspaceController scope, MemorySecrets secrets})>
fixture(
  Future<http.Response> Function(http.Request) handler, {
  MemorySecrets? secrets,
}) async {
  final storage = secrets ?? MemorySecrets();
  final api = ApiClient(
    SessionVault(storage),
    factory: () => MockClient(handler),
  );
  await api.configure(parseServer('https://api.example.test'));
  final session = AppSession(api)
    ..ready = true
    ..user = {'id': 'user-a', 'name': 'Example', 'email': 'person@example.test'}
    ..workspaces = [
      {
        'id': 'space-a',
        'name': 'Personal',
        'kind': 'personal',
        'role': 'owner',
        'status': 'active',
      },
    ];
  session.selectWorkspace(session.workspaces.first);
  final scope = WorkspaceController(session)..data = bootstrap();
  return (session: session, scope: scope, secrets: storage);
}

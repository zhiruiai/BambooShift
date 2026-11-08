import 'dart:convert';

import '../../core/api.dart';
import '../apps/app_approval_data.dart';

const actionStates = [
  'pending',
  'running',
  'done',
  'error',
  'cancelled',
  'rejected',
];
final _uuid = RegExp(r'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$');

class ChatAction {
  ChatAction(this.kind, this.value);
  final String kind;
  final Json value;
  String get id => value['id'] as String;
  String get status => value['status'] as String;
  bool get terminal => status != 'pending' && status != 'running';
  String get title => kind == 'app'
      ? '${value['appName']} · ${value['toolName']}'
      : value['type'] as String;
  ExactAppRead? get exactAppRead =>
      kind == 'app' ? ExactAppRead.forAction(value) : null;
  String? get appApprovalReceipt =>
      kind == 'app' ? appApprovalUsage(value['interactiveApproval']) : null;
  String get fingerprint => canonical({
    'kind': kind,
    for (final key in [
      'id',
      'agentId',
      'conversationId',
      'requester',
      'createdAt',
      'expiresAt',
      'connectionId',
      'appName',
      'toolName',
      'arguments',
      'source',
      'policy',
      'interactiveApproval',
      'type',
      'payload',
      'screenBinding',
      'desktopSession',
    ])
      if (value.containsKey(key)) key: value[key],
  });
  bool canDecide(String userId, bool owner) {
    if (!value.containsKey('requester')) return owner;
    final requester = value['requester'];
    return requester is Map &&
        requester['userId'] is String &&
        requester['userId'] == userId;
  }

  String decisionPath(bool approve) => kind == 'app'
      ? '/app-actions/$id/decision'
      : '/computer/actions/$id/${approve ? 'approve' : 'reject'}';
  Json decisionBody(bool approve, {bool alwaysAllow = false}) => kind != 'app'
      ? {}
      : alwaysAllow
      ? {'decision': 'always_allow'}
      : {'approve': approve};
  static ChatAction? fromMessage(Json message) {
    if (message['role'] != 'assistant' ||
        !['approval', 'computer'].contains(message['kind'])) {
      return null;
    }
    final metadata = message['metadata'];
    if (metadata is! Map) return null;
    final kind = message['kind'] == 'computer' ? 'computer' : 'app';
    final value = metadata[kind == 'app' ? 'appAction' : 'action'];
    if (value is! Json ||
        value['id'] is! String ||
        !_uuid.hasMatch(value['id']) ||
        !actionStates.contains(value['status']) ||
        value['agentId'] != message['agentId']) {
      return null;
    }
    if (kind == 'app' &&
        (value['conversationId'] != message['conversationId'] ||
            value['appName'] is! String ||
            value['toolName'] is! String ||
            value['arguments'] is! Map)) {
      return null;
    }
    if (kind == 'computer' &&
        (value['type'] is! String || value['payload'] is! Map)) {
      return null;
    }
    return ChatAction(kind, value);
  }
}

String canonical(Object? value) => jsonEncode(_ordered(value));
Object? _ordered(Object? value) {
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();
    return {for (final key in keys) key: _ordered(value[key])};
  }
  if (value is List) return value.map(_ordered).toList();
  return value;
}

String actionText(Object? value, {int maximum = 16000}) {
  final text = value is String
      ? value
      : const JsonEncoder.withIndent('  ').convert(value);
  return text.length <= maximum ? text : '${text.substring(0, maximum)}…';
}

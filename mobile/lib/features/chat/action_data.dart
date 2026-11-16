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
final _bundleId = RegExp(r'^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$');
final _control = RegExp(r'[\x00-\x1f\x7f-\x9f]');
final _invalidSnapshot = RegExp(r'[^a-f0-9]');
final _invalidElement = RegExp(r'[^A-Za-z0-9_-]');
final _invalidReplacement = RegExp(
  r'[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ud800-\udfff]',
  unicode: true,
);
const macAppOpenAction = 'desktop_ax_open';
const macAppPressAction = 'desktop_ax_press';
const macAppSetTextAction = 'desktop_ax_set_text';
const _macAppActions = {
  macAppOpenAction,
  macAppPressAction,
  macAppSetTextAction,
};

String? _macTargetText(Object? value, int limit) =>
    value is String &&
        value.length <= limit &&
        utf8.encode(value).length <= limit &&
        !_control.hasMatch(value)
    ? value.trim()
    : null;

bool _macReplacementReadable(Object? text) =>
    text is String &&
    text.isNotEmpty &&
    text.length <= 4000 &&
    !_invalidReplacement.hasMatch(text) &&
    text.runes.length <= 2000;

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
  bool get isMacAppAction =>
      kind == 'computer' && _macAppActions.contains(value['type']);
  bool get opensMacApp =>
      kind == 'computer' && value['type'] == macAppOpenAction;
  ({String app, String bundleId})? get macAppTarget {
    if (!opensMacApp) return null;
    if (value
        case {
          'target': {
            'app': final String app,
            'bundleId': final String bundleId,
          },
          'payload': {
            'type': macAppOpenAction,
            'bundleId': final String requested,
          },
        }
        when (_macTargetText(app, 512)?.isNotEmpty ?? false) &&
            bundleId.length <= 300 &&
            bundleId.trim() == bundleId &&
            _bundleId.hasMatch(bundleId) &&
            !bundleId.toLowerCase().startsWith('com.openbot.') &&
            bundleId.toLowerCase() == requested.toLowerCase()) {
      return (app: app.trim(), bundleId: bundleId);
    }
    return null;
  }

  ({String app, String windowTitle, String role, String label, String? text})?
  get macControlTarget {
    if (!isMacAppAction || opensMacApp) return null;
    final payload = value['payload'], target = value['target'];
    if (payload is! Json || target is! Json || payload['type'] != title) {
      return null;
    }
    final snapshot = payload['snapshotToken'], element = payload['elementId'];
    if (snapshot is! String ||
        snapshot.length != 64 ||
        _invalidSnapshot.hasMatch(snapshot) ||
        element is! String ||
        element.isEmpty ||
        element.length > 64 ||
        _invalidElement.hasMatch(element)) {
      return null;
    }
    final replacing = title == macAppSetTextAction;
    final text = payload['text'];
    if (payload.length != (replacing ? 4 : 3) ||
        (replacing && !_macReplacementReadable(text))) {
      return null;
    }
    final app = _macTargetText(target['app'], 512);
    final role = _macTargetText(target['role'], 160);
    final label = _macTargetText(target['label'], 1024);
    final window = target.containsKey('windowTitle')
        ? _macTargetText(target['windowTitle'], 1024)
        : '';
    if (app == null ||
        app.isEmpty ||
        role == null ||
        label == null ||
        (role.isEmpty && label.isEmpty) ||
        window == null) {
      return null;
    }
    return (
      app: app,
      windowTitle: window,
      role: role,
      label: label,
      text: text as String?,
    );
  }

  bool get macAppRequestReadable =>
      opensMacApp ? macAppTarget != null : macControlTarget != null;

  String get fingerprint => canonical({
    'kind': kind,
    if (isMacAppAction && value.containsKey('target'))
      'target': value['target'],
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
        (value['type'] is! String ||
            (value['payload'] is! Map &&
                !_macAppActions.contains(value['type'])))) {
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

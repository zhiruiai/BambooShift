import 'dart:convert';

import '../../core/api.dart';
import '../../core/request_ids.dart';

final appId = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
final _toolName = RegExp(r'^[A-Za-z0-9_.:/-]{1,128}$');
const appStates = {'connected', 'disconnected', 'needs_auth', 'error'};
const flowStates = {
  'preparing',
  'pending',
  'callback_received',
  'exchanging',
  'complete',
  'cancelled',
  'expired',
  'error',
};
bool terminalFlow(Json? flow) =>
    {'complete', 'cancelled', 'expired', 'error'}.contains(flow?['status']);

Json connectionData(Object? value) {
  if (value is! Json ||
      !appId.hasMatch(value['id'] as String? ?? '') ||
      !appId.hasMatch(value['revision'] as String? ?? '') ||
      value['name'] is! String ||
      value['url'] is! String ||
      !appStates.contains(value['status']) ||
      !{'none', 'bearer', 'oauth'}.contains(value['authType']) ||
      value['toolCount'] is! int ||
      value['hasCredential'] is! bool) {
    throw const ApiException('INVALID_RESPONSE', 'requestFailed');
  }
  return Map<String, dynamic>.from(value);
}

Json? flowData(Object? value, String connectionId, [String? flowId]) {
  if (value == null && flowId == null) return null;
  if (value is! Json ||
      !appId.hasMatch(value['id'] as String? ?? '') ||
      value['connectionId'] != connectionId ||
      (flowId != null && value['id'] != flowId) ||
      !appId.hasMatch(value['connectionRevision'] as String? ?? '') ||
      !flowStates.contains(value['status']) ||
      value['scopes'] is! List ||
      !(value['scopes'] as List).every((v) => v is String)) {
    throw const ApiException('INVALID_RESPONSE', 'requestFailed');
  }
  return Map<String, dynamic>.from(value);
}

List<Json> toolData(Object? value) {
  if (value is! List ||
      value.length > 64 ||
      value.any(
        (v) =>
            v is! Json ||
            !validToolName(v['name']) ||
            v['description'] is! String ||
            v['inputSchema'] is! Json,
      )) {
    throw const ApiException('INVALID_RESPONSE', 'requestFailed');
  }
  final tools = value.cast<Json>();
  if (tools.map((v) => v['name']).toSet().length != tools.length) {
    throw const ApiException('INVALID_RESPONSE', 'requestFailed');
  }
  return tools;
}

bool validToolName(Object? value) =>
    value is String && _toolName.hasMatch(value);

bool supportsToolAccess(Json? app) =>
    app?['status'] == 'connected' && app?['toolAccessSupported'] == true;

bool _validToolRevision(Object? value) =>
    value is String && appId.hasMatch(value);

({bool enabled, String revision})? toolAccess(Json? tool) {
  final access = tool?['access'];
  if (access is! Json ||
      access['enabled'] is! bool ||
      !_validToolRevision(access['revision'])) {
    return null;
  }
  return (
    enabled: access['enabled'] as bool,
    revision: access['revision'] as String,
  );
}

Json toolAccessBody(Json marker) => {
  'toolName': marker['toolName'],
  'enabled': marker['enabled'],
  'expectedConnectionRevision': marker['revision'],
  'expectedToolRevision': marker['toolRevision'],
};

String? toolAccessConflict(Object error) =>
    error is ApiException && error.status == 409
    ? switch (error.code) {
        'APP_TOOL_ACCESS_CHANGED' => 'mobileAppsToolChanged',
        'APP_TOOL_ACCESS_LIMIT' => 'mobileAppsToolLimit',
        _ => null,
      }
    : null;

List<Json> updateToolAccess(List<Json> tools, Object? value, Json marker) {
  final tool = toolData([value]).single;
  final access = toolAccess(tool);
  if (tool['name'] != marker['toolName'] ||
      access?.enabled != marker['enabled'] ||
      access?.revision == marker['toolRevision']) {
    throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
  }
  return [
    for (final previous in tools)
      previous['name'] == tool['name'] ? tool : previous,
  ];
}

Json addConnectionBody(Json input) {
  final name = (input['name'] as String? ?? '').trim();
  final url = (input['url'] as String? ?? '').trim();
  final endpoint = Uri.tryParse(url);
  final auth = input['authType'];
  final token = input['token'] as String? ?? '';
  if (name.isEmpty ||
      name.length > 80 ||
      RegExp(r'[\x00-\x1f\x7f]').hasMatch(name) ||
      endpoint == null ||
      endpoint.scheme != 'https' ||
      !endpoint.hasAuthority ||
      endpoint.userInfo.isNotEmpty ||
      endpoint.hasFragment ||
      endpoint.hasQuery ||
      !{'none', 'bearer', 'oauth'}.contains(auth) ||
      input['shared'] != true ||
      (auth == 'bearer' &&
          (!RegExp(r'^[\x21-\x7e]{1,4096}$').hasMatch(token) ||
              name.contains(token) ||
              url.contains(token)))) {
    throw const ApiException('INVALID_APP', 'mobileAppsInvalid');
  }
  return {
    'name': name,
    'url': url,
    'authType': auth,
    'shared': true,
    if (auth == 'bearer') 'token': token,
  };
}

String appFingerprint(Json app) =>
    jsonEncode([app['name'], app['url'], app['authType']]);

Json pendingData(String text) {
  final value = jsonDecode(text);
  const kinds = {
    'add',
    'reconnect',
    'disconnect',
    'remove',
    'oauthStart',
    'oauthFinish',
    'oauthCancel',
    'toolAccess',
  };
  if (value is! Json ||
      value['version'] != 1 ||
      !isRequestId(value['operationId']) ||
      !kinds.contains(value['kind']) ||
      value.keys.any(
        (k) => !{
          'version',
          'operationId',
          'kind',
          'connectionId',
          'revision',
          'flowId',
          'fingerprint',
          if (value['kind'] == 'toolAccess') ...{
            'toolName',
            'toolRevision',
            'enabled',
          },
        }.contains(k),
      ) ||
      (value['kind'] != 'add' &&
          !appId.hasMatch(value['connectionId'] as String? ?? '')) ||
      (value['kind'] == 'add' &&
          (value['fingerprint'] is! String ||
              (value['fingerprint'] as String).length > 8192)) ||
      (value['revision'] != null &&
          !appId.hasMatch(value['revision'] as String? ?? '')) ||
      (value['flowId'] != null &&
          !appId.hasMatch(value['flowId'] as String? ?? '')) ||
      (value['kind'] == 'toolAccess' &&
          (!validToolName(value['toolName']) ||
              !_validToolRevision(value['revision']) ||
              !_validToolRevision(value['toolRevision']) ||
              value['enabled'] is! bool))) {
    throw const ApiException('INVALID_PENDING', 'mobileAppsStorage');
  }
  return value;
}

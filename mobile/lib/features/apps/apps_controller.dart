import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'apps_data.dart';
import 'apps_transport.dart';
import 'apps_pending.dart';
import 'custom_mcp_target.dart';
import 'oauth_launch.dart';

part 'apps_add_connection.dart';

class AppsController extends ChangeNotifier {
  AppsController(this.scope, {BrowserLauncher? launcher})
    : pendingChecks = AppsPendingChecks(scope),
      transport = AppsTransport(scope),
      launcher = launcher ?? launchOAuthBrowser {
    scope.session.addListener(_scopeChanged);
  }
  final WorkspaceController scope;
  final AppsTransport transport;
  final BrowserLauncher launcher;
  List<Json> apps = [];
  final Map<String, List<Json>> tools = {};
  final Map<String, String> toolFeedback = {};
  final Map<String, Json?> flows = {};
  final AppsPendingChecks pendingChecks;
  Json? pendingFor([String? id]) => pendingChecks.entries[id ?? 'add'];
  bool get hasPending => pendingChecks.entries.isNotEmpty;
  String? selectedId;
  String? error;
  bool ready = false, busy = false, blocked = false;
  bool _closed = false;
  bool get active => !_closed && scope.active;
  bool get canWrite => active && scope.owner && ready && !busy && !blocked;
  bool get canAdd => canWrite && pendingFor() == null;
  bool canWriteConnection(String id) => canWrite && pendingFor(id) == null;
  bool canManageTools(String id) =>
      canWriteConnection(id) && supportsToolAccess(find(id));

  void guard() {
    transport.guard();
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  void _scopeChanged() {
    if (!active) {
      transport.close();
      apps = [];
      tools.clear();
      toolFeedback.clear();
      flows.clear();
    }
    if (!_closed) notifyListeners();
  }

  Json? find(String id) {
    for (final app in apps) {
      if (app['id'] == id) return app;
    }
    return null;
  }

  Future<void> initialize() async {
    try {
      guard();
      await pendingChecks.load();
      guard();
      ready = true;
      await refresh();
    } catch (e) {
      if (active) {
        blocked = true;
        error = 'mobileAppsStorage';
        notifyListeners();
      }
    }
  }

  Future<void> _load(String? connectionId, {bool readTools = false}) async {
    final detailsId = connectionId ?? selectedId;
    final toolCheck = pendingFor(detailsId);
    final checkTools =
        detailsId != null &&
        (readTools ||
            tools.containsKey(detailsId) ||
            toolCheck?['kind'] == 'toolAccess');
    if (checkTools) {
      tools.remove(detailsId);
      toolFeedback.remove(detailsId);
    }
    final result = await transport.send('GET', '/apps');
    guard();
    if (result is! List || result.length > 20) {
      throw const ApiException('INVALID_RESPONSE', 'requestFailed');
    }
    final next = result.map(connectionData).toList();
    if (next.map((a) => a['id']).toSet().length != next.length) {
      throw const ApiException('INVALID_RESPONSE', 'requestFailed');
    }
    tools.removeWhere(
      (id, _) => !next.any(
        (a) => a['id'] == id && a['revision'] == find(id)?['revision'],
      ),
    );
    apps = next;
    final ids = <String>{
      ?connectionId,
      ?selectedId,
      for (final p in pendingChecks.entries.values)
        if (p['kind'] != 'toolAccess' && p['connectionId'] is String)
          p['connectionId'],
    };
    final freshFlows = <String>{};
    for (final id in ids) {
      if (find(id)?['authType'] == 'oauth' && scope.owner) {
        try {
          flows[id] = flowData(
            await transport.send('GET', '/apps/$id/oauth'),
            id,
          );
          guard();
          freshFlows.add(id);
        } catch (e) {
          guard();
          error = e is ApiException ? e.message : 'requestFailed';
        }
      }
    }
    for (final p in pendingChecks.entries.values.toList()) {
      if (p['kind'] == 'toolAccess') continue;
      final id = p['connectionId'] as String?;
      final current = find(id ?? '');
      var resolved = p['kind'] == 'add'
          ? apps.any((a) => appFingerprint(a) == p['fingerprint'])
          : current == null ||
                (!p['kind'].toString().startsWith('oauth') &&
                    current['revision'] != p['revision']);
      if (current != null && p['kind'] == 'oauthStart') {
        final f = flows[id];
        resolved =
            freshFlows.contains(id) &&
            f != null &&
            f['connectionRevision'] != p['revision'];
      } else if (current != null &&
          (p['kind'] == 'oauthFinish' || p['kind'] == 'oauthCancel')) {
        try {
          final f = flowData(
            await transport.send('GET', '/apps/$id/oauth/${p['flowId']}'),
            id!,
            p['flowId'],
          );
          guard();
          resolved = terminalFlow(f);
          if (flows[id]?['id'] == f?['id']) flows[id] = f;
        } catch (e) {
          guard();
          error = e is ApiException ? e.message : 'requestFailed';
        }
      }
      if (resolved) await pendingChecks.resolve(p);
      guard();
    }
    if (checkTools) await _readTools(detailsId, toolCheck);
  }

  Future<void> abandonLocalDraft([String? id]) async {
    final marker = pendingFor(id);
    if (!canWrite || marker == null || marker['kind'] == 'toolAccess') return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await _load(id);
      guard();
      // This only releases the local marker after an explicit user decision.
      await pendingChecks.resolve(marker);
      guard();
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> refresh([String? connectionId]) => _refresh(connectionId);

  Future<void> _refresh(String? connectionId, {bool readTools = false}) async {
    if (!active || busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await _load(connectionId, readTools: readTools);
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> loadTools(String id) => _refresh(id, readTools: true);

  Future<void> _readTools(String id, Json? marker) async {
    final app = find(id);
    if (app?['status'] == 'connected') {
      final result = toolData(await transport.send('GET', '/apps/$id/tools'));
      guard();
      tools[id] = result;
    }
    if (marker?['kind'] != 'toolAccess') return;
    final tool = tools[id]
        ?.where((tool) => tool['name'] == marker!['toolName'])
        .firstOrNull;
    final access = toolAccess(tool);
    if (app?['status'] == 'connected' &&
        (!supportsToolAccess(app) || (tool != null && access == null))) {
      return;
    }
    await pendingChecks.resolve(marker!);
    guard();
    toolFeedback[id] = switch (access?.enabled) {
      true => 'mobileAppsToolCurrentEnabled',
      false => 'mobileAppsToolCurrentDisabled',
      null => 'mobileAppsToolUnavailable',
    };
  }

  Future<Object?> _mutate(
    Json marker,
    String method,
    String path,
    Json? body, {
    bool cancellation = false,
    Future<Object?> Function(Object error, Json saved)? recover,
  }) async {
    final target = pendingTarget(marker);
    if (!canWrite ||
        (pendingFor(target) != null &&
            !(cancellation &&
                pendingFor(target)?['kind'].toString().startsWith('oauth') ==
                    true))) {
      return null;
    }
    busy = true;
    error = null;
    final toolChange = marker['kind'] == 'toolAccess';
    if (toolChange) toolFeedback.remove(target);
    notifyListeners();
    final saved = {'version': 1, 'operationId': requestId(), ...marker};
    var sent = false;
    try {
      guard();
      await pendingChecks.claim(saved, cancelOAuth: cancellation);
      guard();
      sent = true;
      final result = await transport.send(method, path, body: body);
      guard();
      if (toolChange) {
        tools[target] = updateToolAccess(tools[target] ?? [], result, saved);
      } else if (marker['kind'] == 'remove') {
        if (result is! Json || result['ok'] != true) {
          throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
        }
        apps.removeWhere((a) => a['id'] == marker['connectionId']);
        tools.remove(marker['connectionId']);
        flows.remove(marker['connectionId']);
      } else if (marker['kind'].toString().startsWith('oauth')) {
        flows[marker['connectionId']] = flowData(
          result,
          marker['connectionId'],
          marker['flowId'],
        );
      } else {
        final app = connectionData(result);
        if (marker['connectionId'] != null &&
            app['id'] != marker['connectionId']) {
          throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
        }
        apps = [...apps.where((a) => a['id'] != app['id']), app];
        tools.remove(app['id']);
      }
      await pendingChecks.resolve(saved);
      guard();
      if (toolChange) return result;
      try {
        await _load(marker['connectionId']);
      } catch (e) {
        guard();
        error = e is ApiException ? e.message : 'requestFailed';
      }
      return result;
    } catch (e) {
      if (active && toolChange && sent) {
        final conflict = toolAccessConflict(e);
        try {
          if (conflict != null) await pendingChecks.resolve(saved);
          await _load(target, readTools: true);
        } catch (_) {
          if (active) tools.remove(target);
        }
        if (active && conflict != null) toolFeedback[target] = conflict;
      } else if (active) {
        final existing = sent ? await recover?.call(e, saved) : null;
        if (!active || existing != null) return existing;
        error = e is ApiException ? e.message : 'requestUnknown';
      }
      return null;
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<Object?> add(Json input, {String? reviewedEndpoint}) =>
      _addConnection(input, reviewedEndpoint);

  void _rejectInvalidConnection() {
    error = 'mobileAppsInvalid';
    notifyListeners();
  }

  Future<Object?> setToolAccess(
    String id,
    String connectionRevision,
    Json tool,
    bool enabled,
  ) async {
    final name = tool['name'];
    final reviewed = toolAccess(tool);
    final current = tools[id]
        ?.where((item) => item['name'] == name)
        .firstOrNull;
    if (!canManageTools(id) ||
        find(id)?['revision'] != connectionRevision ||
        reviewed == null ||
        toolAccess(current) != reviewed ||
        reviewed.enabled == enabled) {
      return null;
    }
    final marker = {
      'kind': 'toolAccess',
      'connectionId': id,
      'revision': connectionRevision,
      'toolName': name,
      'toolRevision': reviewed.revision,
      'enabled': enabled,
    };
    return _mutate(
      marker,
      'PUT',
      '/apps/$id/tools/access',
      toolAccessBody(marker),
    );
  }

  Future<Object?> change(String id, String operation, {String? token}) async {
    final current = find(id);
    if (current == null ||
        !{'reconnect', 'disconnect', 'remove'}.contains(operation)) {
      return null;
    }
    if (token != null &&
        (!RegExp(r'^[\x21-\x7e]{1,4096}$').hasMatch(token) ||
            !(current['authType'] == 'bearer' ||
                (current['authType'] == 'none' &&
                    current['status'] == 'needs_auth')))) {
      error = 'mobileAppsInvalid';
      notifyListeners();
      return null;
    }
    return _mutate(
      {'kind': operation, 'connectionId': id, 'revision': current['revision']},
      operation == 'remove' ? 'DELETE' : 'POST',
      '/apps/$id${operation == 'remove' ? '' : '/$operation'}',
      operation == 'reconnect' ? {'token': ?token} : null,
    );
  }

  Future<Object?> startOAuth(
    String id, {
    String? clientId,
    String? clientSecret,
  }) async {
    final app = find(id);
    if (app == null ||
        app['authType'] != 'oauth' ||
        (flows[id] != null && !terminalFlow(flows[id]))) {
      return null;
    }
    if ([clientId, clientSecret].any(
      (value) =>
          value?.isNotEmpty == true &&
          !RegExp(r'^[\x21-\x7e]{1,4096}$').hasMatch(value!),
    )) {
      error = 'mobileAppsInvalidOAuth';
      notifyListeners();
      return null;
    }
    return _mutate(
      {'kind': 'oauthStart', 'connectionId': id, 'revision': app['revision']},
      'POST',
      '/apps/$id/oauth/start',
      {
        'expectedRevision': app['revision'],
        if (clientId?.isNotEmpty == true) 'clientId': clientId,
        if (clientSecret?.isNotEmpty == true) 'clientSecret': clientSecret,
      },
    );
  }

  Future<Object?> finishOAuth(String id) async {
    final flow = flows[id];
    if (flow?['status'] != 'callback_received') return null;
    return _mutate(
      {'kind': 'oauthFinish', 'connectionId': id, 'flowId': flow!['id']},
      'POST',
      '/apps/$id/oauth/${flow['id']}/finish',
      {},
    );
  }

  Future<Object?> cancelOAuth(String id) async {
    final flow = flows[id];
    if (flow == null || terminalFlow(flow)) return null;
    return _mutate(
      {'kind': 'oauthCancel', 'connectionId': id, 'flowId': flow['id']},
      'POST',
      '/apps/$id/oauth/${flow['id']}/cancel',
      {},
      cancellation: true,
    );
  }

  Future<void> openOAuth(String id) async {
    final flow = flows[id];
    if (!canWriteConnection(id) || flow?['status'] != 'pending') return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      final fid = flow!['id'] as String;
      final result = await transport.send(
        'POST',
        '/apps/$id/oauth/$fid/launch',
        body: {},
      );
      guard();
      if (result is! Json) {
        throw const ApiException('INVALID_RESPONSE', 'requestFailed');
      }
      final uri = oauthLaunchUri(
        scope.session.api.server!,
        scope.workspaceId,
        id,
        fid,
        result['launchPath'],
      );
      guard();
      if (!scope.owner) {
        throw const ApiException('FORBIDDEN', 'mobileAppsOwnerOnly');
      }
      if (!await launcher(uri)) {
        throw const ApiException('LAUNCH_FAILED', 'mobileAppsLaunchFailed');
      }
      guard();
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'mobileAppsLaunchFailed';
      }
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    scope.session.removeListener(_scopeChanged);
    transport.close();
    super.dispose();
  }
}

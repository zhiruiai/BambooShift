import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'request_ids.dart';
import 'workspace_controller.dart';

class CreationController extends ChangeNotifier {
  CreationController(this.scope, this.kind)
    : _origin = scope.session.api.server!.origin;
  final WorkspaceController scope;
  final String kind;
  Json? pending;
  Json? receipt;
  String? error;
  bool busy = false;
  bool ready = false;
  bool _closed = false;
  bool get active => !_closed && scope.active;
  void _guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  final String _origin;
  String get _purpose => 'create:${scope.userId}:${scope.workspaceId}:$kind';
  Future<void> initialize() async {
    try {
      final saved = await scope.session.api.vault.read(_origin, _purpose);
      if (!active) return;
      if (saved != null) {
        final value = jsonDecode(saved);
        if (value is! Json ||
            value['kind'] != kind ||
            !isRequestId(value['requestId'])) {
          throw const ApiException('INVALID_PENDING', 'requestFailed');
        }
        pending = value;
      }
      ready = true;
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    }
    if (active) {
      notifyListeners();
      if (pending != null) await check();
    }
  }

  Future<void> start(Json fields) async {
    if (!active || !ready || busy || pending != null) return;
    pending =
        jsonDecode(
              jsonEncode({...fields, 'kind': kind, 'requestId': requestId()}),
            )
            as Json;
    await _work(() async {
      await scope.session.api.vault.write(
        _origin,
        _purpose,
        jsonEncode(pending),
        allowed: () => active,
      );
      _guard();
      await _post();
    });
  }

  Future<void> _post() async {
    await scope.session.api.vault.write(
      _origin,
      _purpose,
      jsonEncode(pending),
      allowed: () => active,
    );
    _guard();
    _accept(await scope.request('POST', '/creation-requests', body: pending));
  }

  Future<void> retry() async {
    if (pending != null) await _work(_post);
  }

  Future<void> check() async {
    if (pending != null) {
      await _work(() async {
        _accept(
          await scope.request(
            'GET',
            '/creation-requests/${pending!['requestId']}',
          ),
        );
      });
    }
  }

  Future<void> cancel() async {
    if (pending != null) {
      await _work(() async {
        final result = await scope.request(
          'POST',
          '/creation-requests/${pending!['requestId']}/cancel',
          body: {},
        );
        if (result['status'] == 'not_submitted' &&
            result['requestId'] == pending!['requestId'] &&
            result['userId'] == scope.userId &&
            result['workspaceId'] == scope.workspaceId) {
          await _clear();
        } else {
          _accept(result);
        }
      });
    }
  }

  void _accept(Json value) {
    _guard();
    if (value['requestId'] != pending?['requestId'] ||
        value['kind'] != kind ||
        value['workspaceId'] != scope.workspaceId ||
        value['userId'] != scope.userId ||
        !['created', 'missing'].contains(value['status'])) {
      throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
    }
    if (value['status'] == 'created') {
      final conversation = value['conversation'];
      final agents = value['agents'];
      if (conversation is! Json ||
          agents is! List ||
          conversation['id'] != value['conversationId'] ||
          conversation['agentIds'] is! List ||
          (conversation['agentIds'] as List).isEmpty ||
          !(conversation['agentIds'] as List).every(
            (id) => agents.any((a) => a is Map && a['id'] == id),
          )) {
        throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
      }
      if (kind == 'bot' &&
          (conversation['isGroup'] == true ||
              (conversation['agentIds'] as List).length != 1 ||
              conversation['agentIds'][0] != value['agentIds']?[0])) {
        throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
      }
    }
    receipt = value;
  }

  Future<void> finish() async {
    if (receipt != null) await _work(_clear);
  }

  Future<void> _clear() async {
    await scope.session.api.vault.delete(_origin, _purpose);
    if (active) {
      pending = null;
      error = null;
      notifyListeners();
    }
  }

  Future<void> _work(Future<void> Function() action) async {
    if (!active || busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await action();
    } catch (e) {
      if (active) {
        if (e is ApiException &&
            e.status == 410 &&
            e.code == 'CREATION_REQUEST_CLOSED') {
          await _clear();
        } else {
          error = e is ApiException ? e.message : 'requestFailed';
        }
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
    super.dispose();
  }
}

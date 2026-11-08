import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import '../../core/request_ids.dart';
import 'library_data.dart';
import 'library_pending.dart';
import 'library_transport.dart';

class TemplateOperation extends ChangeNotifier {
  TemplateOperation(this.transport)
    : recovery = LibraryPending(transport, 'templates');
  final LibraryTransport transport;
  final LibraryPending recovery;
  Json? body, result;
  String? error;
  bool busy = false, ready = false, closed = false;
  Json? get pending => recovery.value;
  bool get active => !closed && transport.active;
  bool get locked => !ready || busy || pending != null;
  bool get canRetry => active && !busy && pending != null && body != null;
  String get base =>
      transport.workspacePath(transport.scope.workspaceId, '/bot-templates');
  Future<void> work(Future<void> Function() action) async {
    if (!active || busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await action();
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestUnknown';
    } finally {
      if (!closed) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> initialize() => work(() async {
    await recovery.load();
    if (pending != null &&
        (!{
              'templateCreate',
              'templateEdit',
              'templateRefresh',
              'templatePublish',
              'templateRevoke',
            }.contains(pending!['kind']) ||
            pending!['workspaceId'] != transport.scope.workspaceId ||
            (pending!['kind'] == 'templateCreate'
                ? !libraryId(pending!['sourceId'])
                : !isRequestId(pending!['sourceId'])))) {
      invalidLibrary();
    }
    ready = true;
    if (pending != null) await lookup();
  });
  String endpoint(Json p) {
    if (p['kind'] == 'templateCreate') return base;
    final op = p['kind'].toString().substring(8).toLowerCase();
    return '$base/${p['sourceId']}${op == 'edit' ? '' : '/$op'}';
  }

  Future<void> start(String kind, String sourceId, Json input) => work(
    () async {
      if (!ready ||
          pending != null ||
          !{'Create', 'Edit', 'Refresh', 'Publish', 'Revoke'}.contains(kind) ||
          !libraryId(sourceId)) {
        return;
      }
      await transport.owner(transport.scope.workspaceId);
      final next = <String, dynamic>{
        ...libraryCopy(input),
        'requestId': requestId(),
      };
      await recovery.claim(
        'template$kind',
        transport.scope.workspaceId,
        sourceId,
        next,
      );
      transport.guard();
      body = next;
      result = null;
      await dispatch();
    },
  );
  Future<void> dispatch() async {
    final p = pending!;
    await transport.owner(p['workspaceId']);
    try {
      final value = ownedTemplate(
        await transport.send(
          p['kind'] == 'templateEdit' ? 'PATCH' : 'POST',
          endpoint(p),
          body: body,
        ),
      );
      if (p['kind'] != 'templateCreate' && value['id'] != p['sourceId']) {
        invalidLibrary();
      }
      result = value;
    } on ApiException catch (e) {
      if ([400, 409, 413, 422].contains(e.status) &&
          e.code == 'BOT_TEMPLATE_NOT_APPLIED') {
        await recovery.clear(p);
        body = null;
        result = null;
      }
      rethrow;
    }
  }

  Future<void> lookup() async {
    final p = pending;
    if (p == null) return;
    await transport.owner(p['workspaceId']);
    final rows = libraryRows(
      await transport.send('GET', '$base?requestId=${p['requestId']}'),
    );
    if (rows.length > 1) invalidLibrary();
    if (rows.isEmpty) {
      result = null;
      throw const ApiException('UNKNOWN', 'mobileLibraryUnknown');
    }
    final value = ownedTemplate(rows.single);
    if (p['kind'] != 'templateCreate' && value['id'] != p['sourceId']) {
      invalidLibrary();
    }
    result = value;
  }

  Future<void> check() => work(lookup);
  Future<void> sync() => work(() async {
    if (pending == null || result == null) return;
    await transport.owner(transport.scope.workspaceId);
    final value = ownedTemplate(
      await transport.send('POST', '$base/${result!['id']}/sync', body: {}),
    );
    if (value['id'] != result!['id']) invalidLibrary();
    result = value;
  });
  Future<void> retry() => work(() async {
    if (pending != null && body != null) await dispatch();
  });
  Future<bool> finish() async {
    var done = false;
    await work(() async {
      if (pending == null ||
          result == null ||
          result!['projectionPending'] == true) {
        return;
      }
      await recovery.clear(pending!);
      transport.guard();
      body = null;
      result = null;
      done = true;
    });
    return done;
  }

  @override
  void dispose() {
    closed = true;
    body = null;
    super.dispose();
  }
}

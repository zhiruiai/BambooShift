import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import '../../core/request_ids.dart';
import 'library_data.dart';
import 'library_navigation.dart';
import 'library_pending.dart';
import 'library_transport.dart';

class LibraryInstaller extends ChangeNotifier {
  LibraryInstaller(this.transport)
    : recovery = LibraryPending(transport, 'install') {
    transport.scope.session.addListener(identity);
  }
  final LibraryTransport transport;
  final LibraryPending recovery;
  Json? receipt, body;
  String? error;
  bool busy = false, ready = false, blocked = false, closed = false;
  Json? get pending => recovery.value;
  bool get active => !closed && transport.active;
  bool get canRetry =>
      active &&
      !busy &&
      pending != null &&
      (body != null || pending!['kind'] == 'join');
  void identity() {
    if (!active) body = null;
    if (!closed) notifyListeners();
  }

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
    try {
      await recovery.load();
    } catch (_) {
      blocked = true;
      rethrow;
    }
    if (pending != null &&
        !{'import', 'copy', 'join'}.contains(pending!['kind'])) {
      blocked = true;
      throw const ApiException('INVALID_PENDING', 'mobileLibraryStorage');
    }
    ready = true;
    if (pending != null) await lookup();
  });
  String endpoint(Json p) => transport.workspacePath(
    p['workspaceId'],
    p['kind'] == 'join'
        ? '/shared-bot-references'
        : p['kind'] == 'copy'
        ? '/bot-copies'
        : '/bot-template-imports',
  );
  Future<void> start({
    required String kind,
    required String workspaceId,
    required String sourceId,
    String? expectedRevision,
    String? name,
    String routineMode = 'pause',
  }) => work(() async {
    if (!ready ||
        blocked ||
        pending != null ||
        !{'join', 'copy', 'import'}.contains(kind)) {
      return;
    }
    if (kind == 'join'
        ? !isRequestId(sourceId)
        : kind == 'import'
        ? !templateToken(sourceId)
        : !libraryId(sourceId)) {
      invalidLibrary();
    }
    await transport.owner(workspaceId, personal: kind == 'join');
    if (kind != 'join' &&
        (!revision(expectedRevision) ||
            !libraryText(name, 40, empty: false) ||
            !{'preserve', 'pause'}.contains(routineMode))) {
      invalidLibrary();
    }
    if (kind == 'copy' && workspaceId != transport.scope.workspaceId) {
      invalidLibrary();
    }
    final next = <String, dynamic>{
      'requestId': requestId(),
      if (kind == 'join')
        'shareId': sourceId
      else ...{
        if (kind == 'copy') 'agentId': sourceId else 'token': sourceId,
        if (kind == 'copy')
          'expectedSourceRevision': expectedRevision
        else
          'expectedRevision': expectedRevision,
        'name': name!.trim(),
        'routineMode': routineMode,
      },
    };
    await recovery.claim(kind, workspaceId, sourceId, next);
    transport.guard();
    body = next;
    await dispatch();
  });
  void accept(Object? value) {
    final p = pending;
    if (value is! Json ||
        p == null ||
        value['requestId'] != p['requestId'] ||
        !libraryId(value['agentId']) ||
        !libraryId(value['conversationId'])) {
      invalidLibrary();
    }
    if (p['kind'] == 'join') {
      if (value['shareId'] != p['sourceId'] ||
          value['workspaceId'] != p['workspaceId'] ||
          value['actorId'] != transport.scope.userId) {
        invalidLibrary();
      }
    } else if (value['skillIds'] is! List ||
        value['routineIds'] is! List ||
        !(value['skillIds'] as List).every(libraryId) ||
        !(value['routineIds'] as List).every(libraryId)) {
      invalidLibrary();
    }
    receipt = libraryCopy(value);
  }

  Future<void> dispatch() async {
    final p = pending!;
    await transport.owner(p['workspaceId'], personal: p['kind'] == 'join');
    try {
      accept(await transport.send('POST', endpoint(p), body: body));
    } on ApiException catch (e) {
      if ([400, 409, 413, 422].contains(e.status) &&
          e.code ==
              (p['kind'] == 'join'
                  ? 'SHARED_BOT_NOT_ADDED'
                  : 'BOT_INSTALL_NOT_STARTED')) {
        await recovery.clear(p);
        body = null;
        receipt = null;
      }
      rethrow;
    }
  }

  Future<void> lookup() async {
    if (pending == null) return;
    final p = pending!;
    await transport.owner(p['workspaceId'], personal: p['kind'] == 'join');
    accept(await transport.send('GET', '${endpoint(p)}/${p['requestId']}'));
  }

  Future<void> check() => work(lookup);
  Future<void> retry() => work(() async {
    if (pending == null) return;
    if (body == null && pending!['kind'] == 'join') {
      body = {
        'requestId': pending!['requestId'],
        'shareId': pending!['sourceId'],
      };
    }
    if (body != null) await dispatch();
  });
  Future<LibraryOpen?> open() async {
    LibraryOpen? destination;
    await work(() async {
      await lookup();
      if (receipt == null || pending == null) return;
      final p = pending!, r = receipt!;
      final target = await transport.owner(
        p['workspaceId'],
        personal: p['kind'] == 'join',
      );
      final data = await transport.send(
        'GET',
        transport.workspacePath(p['workspaceId'], '/bootstrap'),
      );
      final candidate = LibraryOpen(
        workspace: target,
        agentId: r['agentId'],
        conversationId: r['conversationId'],
        shareId: p['kind'] == 'join' ? p['sourceId'] : null,
      );
      if (data is! Json || !candidate.matches(data)) {
        throw const ApiException(
          'MISSING_BOT',
          'mobileLibraryCreatedUnavailable',
        );
      }
      await transport.owner(p['workspaceId'], personal: p['kind'] == 'join');
      transport.guard();
      destination = candidate;
    });
    return destination;
  }

  Future<bool> finish() async {
    var done = false;
    await work(() async {
      if (receipt == null || pending == null) return;
      await recovery.clear(pending!);
      transport.guard();
      body = null;
      receipt = null;
      done = true;
    });
    return done;
  }

  @override
  void dispose() {
    closed = true;
    body = null;
    transport.scope.session.removeListener(identity);
    super.dispose();
  }
}

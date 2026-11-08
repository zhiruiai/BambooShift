import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'library_data.dart';
import 'library_pending.dart';
import 'library_transport.dart';

class SharingPolicyController extends ChangeNotifier {
  SharingPolicyController(WorkspaceController scope)
    : transport = LibraryTransport(scope) {
    recovery = LibraryPending(transport, 'policy');
  }
  final LibraryTransport transport;
  late final LibraryPending recovery;
  Json? policy;
  String? error;
  String mode = 'disabled';
  bool busy = false, closed = false, ready = false;
  bool get active => !closed && transport.active;
  bool get unknown => recovery.value != null;
  String get path => transport.workspacePath(
    transport.scope.workspaceId,
    '/bot-sharing-policy',
  );
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
    if (unknown &&
        (recovery.value!['kind'] != 'templatePolicy' ||
            recovery.value!['workspaceId'] != transport.scope.workspaceId)) {
      invalidLibrary();
    }
    await load();
    ready = true;
  });
  Future<void> load() async {
    final target = await transport.owner(transport.scope.workspaceId);
    final value = await transport.send('GET', path);
    if (value is! Json ||
        !{'public', 'team-only', 'disabled'}.contains(value['mode']) ||
        (value['mode'] == 'team-only' && target['kind'] != 'team') ||
        (value['revision'] != 'unset' && !isRequestId(value['revision']))) {
      invalidLibrary();
    }
    policy = libraryCopy(value);
    mode = value['mode'];
  }

  Future<void> refresh() => work(load);
  Future<void> save() => work(() async {
    if (!ready ||
        unknown ||
        policy == null ||
        !{'public', 'team-only', 'disabled'}.contains(mode)) {
      return;
    }
    await transport.owner(transport.scope.workspaceId);
    final body = <String, dynamic>{
      'expectedRevision': policy!['revision'],
      'mode': mode,
    };
    await recovery.claim(
      'templatePolicy',
      transport.scope.workspaceId,
      transport.scope.workspaceId,
      {'requestId': requestId(), ...body},
    );
    // A committed policy can still fail while repairing publication projections.
    await transport.send('PUT', path, body: body);
    await load();
    await recovery.clear(recovery.value!);
  });
  Future<void> acknowledge() => work(() async {
    if (!unknown) return;
    await load();
    await recovery.clear(recovery.value!);
  });
  @override
  void dispose() {
    closed = true;
    transport.close();
    super.dispose();
  }
}

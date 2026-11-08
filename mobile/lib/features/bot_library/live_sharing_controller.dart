import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'library_data.dart';
import 'library_pending.dart';
import 'library_transport.dart';
import 'sharing_data.dart';

class LiveSharingController extends ChangeNotifier {
  LiveSharingController(WorkspaceController scope, this.agentId)
    : transport = LibraryTransport(scope) {
    recovery = LibraryPending(transport, 'share:$agentId');
    scope.session.addListener(changed);
  }
  final String agentId;
  final LibraryTransport transport;
  late final LibraryPending recovery;
  Json? snapshot, inspectedApp;
  List<Json> files = [], apps = [], selectedFiles = [], selectedApps = [];
  String teamId = '', audience = 'team', query = '';
  final members = <String>{};
  final tools = <String>{};
  String? error;
  bool busy = false,
      ready = false,
      closed = false,
      filesChanged = false,
      appsChanged = false,
      dirty = false,
      truncated = false;
  bool get active => !closed && transport.active;
  bool get unknown => recovery.value != null;
  bool get locked => !ready || busy || unknown;
  Json? get share => snapshot?['share'];
  List<Json> get teams =>
      snapshot == null ? [] : libraryRows(snapshot!['teams']);
  Json? get team => teams.where((v) => v['id'] == teamId).firstOrNull;
  String get path => transport.workspacePath(
    transport.scope.workspaceId,
    '/agents/$agentId/sharing',
  );
  void changed() {
    if (!closed) notifyListeners();
  }

  Future<void> work(Future<void> Function() action) async {
    if (!active || busy) return;
    busy = true;
    error = null;
    changed();
    try {
      await action();
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestUnknown';
    } finally {
      if (!closed) {
        busy = false;
        changed();
      }
    }
  }

  Future<void> initialize() => work(() async {
    if (!libraryId(agentId)) invalidLibrary();
    await recovery.load();
    final p = recovery.value;
    if (p != null &&
        (!{'shareUpdate', 'shareRevoke'}.contains(p['kind']) ||
            p['sourceId'] != agentId ||
            p['workspaceId'] != transport.scope.workspaceId)) {
      invalidLibrary();
    }
    await load();
    ready = true;
  });
  Future<void> load() async {
    await transport.owner(transport.scope.workspaceId);
    final value = sharingSnapshot(
      await transport.send('GET', path),
      transport.scope.workspaceId,
      agentId,
    );
    final fileOptions = await transport.send(
      'GET',
      '$path/files?query=${Uri.encodeQueryComponent(query)}',
    );
    final appOptions = await transport.send('GET', '$path/apps');
    if (fileOptions is! Json ||
        fileOptions['truncated'] is! bool ||
        appOptions is! Json) {
      invalidLibrary();
    }
    final nextFiles = libraryRows(
      fileOptions['files'],
    ).map((v) => sharedFile(v, inspected: false)).toList();
    final nextApps = libraryRows(
      appOptions['apps'],
    ).map((v) => sharedApp(v, inspected: false)).toList();
    final existingFiles = libraryRows(
      fileOptions['selected'],
    ).map(sharedFile).toList();
    final existingApps = libraryRows(
      appOptions['selected'],
    ).map(sharedApp).toList();
    // Selected rows include changed or unavailable grants and must never become an implicit empty replacement.
    final s = value['share'] as Json?;
    if (existingFiles.length != (s?['files'] as List? ?? []).length ||
        existingApps.length != (s?['apps'] as List? ?? []).length) {
      invalidLibrary();
    }
    for (final f in existingFiles) {
      if (!(s!['files'] as List).any(
        (v) => v['fileId'] == f['fileId'] && v['revision'] == f['revision'],
      )) {
        invalidLibrary();
      }
    }
    for (final a in existingApps) {
      final expected = (s!['apps'] as List)
          .where(
            (v) =>
                v['connectionId'] == a['connectionId'] &&
                v['connectionRevision'] == a['connectionRevision'],
          )
          .firstOrNull;
      if (expected == null ||
          (expected['tools'] as List).length != (a['tools'] as List).length ||
          !(expected['tools'] as List).every(
            (t) => (a['tools'] as List).any(
              (v) => v['name'] == t['name'] && v['revision'] == t['revision'],
            ),
          )) {
        invalidLibrary();
      }
    }
    snapshot = value;
    files = nextFiles;
    apps = nextApps;
    selectedFiles = existingFiles;
    selectedApps = existingApps;
    truncated = fileOptions['truncated'];
    teamId = s?['targetTeamId'] ?? teams.firstOrNull?['id'] ?? '';
    audience = s?['audience'] ?? 'team';
    members
      ..clear()
      ..addAll((s?['memberIds'] as List? ?? []).cast<String>());
    dirty = false;
    filesChanged = false;
    appsChanged = false;
    inspectedApp = null;
    tools.clear();
  }

  Future<void> refresh() => work(load);
  void chooseTeam(String id) {
    if (locked || !teams.any((v) => v['id'] == id)) return;
    teamId = id;
    members.clear();
    dirty = true;
    changed();
  }

  void chooseAudience(String value) {
    if (locked || !{'team', 'selected'}.contains(value)) return;
    audience = value;
    if (value == 'team') members.clear();
    dirty = true;
    changed();
  }

  void member(String id, bool yes) {
    if (locked ||
        team == null ||
        !libraryRows(team!['members']).any((m) => m['userId'] == id)) {
      return;
    }
    yes ? members.add(id) : members.remove(id);
    dirty = true;
    changed();
  }

  Future<void> inspectFile(String id) => work(() async {
    if (!ready || unknown || !files.any((v) => v['fileId'] == id)) return;
    await transport.owner(transport.scope.workspaceId);
    final value = sharedFile(await transport.send('GET', '$path/files/$id'));
    if (value['fileId'] != id) invalidLibrary();
    files = [for (final f in files) f['fileId'] == id ? value : f];
  });
  void selectFile(Json value, bool yes) {
    if (locked || !grantHash(value['revision'])) return;
    final next = [
      ...selectedFiles.where((f) => f['fileId'] != value['fileId']),
    ];
    if (yes) next.add(sharedFile(value));
    if (next.length > 32 ||
        next.fold<int>(0, (n, f) => n + (f['size'] as int)) >
            50 * 1024 * 1024) {
      error = 'mobileLibraryGrantLimit';
      changed();
      return;
    }
    selectedFiles = next;
    filesChanged = true;
    dirty = true;
    changed();
  }

  Future<void> inspectApp(String id) => work(() async {
    if (!ready ||
        unknown ||
        !apps.any((v) => v['connectionId'] == id && v['status'] == 'connected')) {
      return;
    }
    await transport.owner(transport.scope.workspaceId);
    final value = sharedApp(
      await transport.send('GET', '$path/apps/$id'),
      schema: true,
    );
    if (value['connectionId'] != id) invalidLibrary();
    inspectedApp = value;
    tools.clear();
  });
  void tool(String name, bool yes) {
    if (locked ||
        inspectedApp == null ||
        !(inspectedApp!['tools'] as List).any((t) => t['name'] == name)) {
      return;
    }
    yes ? tools.add(name) : tools.remove(name);
    changed();
  }

  void selectApp() {
    if (locked || inspectedApp == null || tools.isEmpty) return;
    final value = libraryCopy(inspectedApp!);
    value['tools'] = (value['tools'] as List)
        .where((t) => tools.contains(t['name']))
        .toList();
    final next = [
      ...selectedApps.where((v) => v['connectionId'] != value['connectionId']),
      value,
    ];
    if (next.length > 20) {
      error = 'mobileLibraryGrantLimit';
      changed();
      return;
    }
    selectedApps = next;
    appsChanged = true;
    dirty = true;
    inspectedApp = null;
    tools.clear();
    changed();
  }

  void removeApp(String id) {
    if (locked) return;
    selectedApps.removeWhere((v) => v['connectionId'] == id);
    appsChanged = true;
    dirty = true;
    changed();
  }

  Future<void> save({bool revoke = false}) => work(() async {
    if (!ready ||
        unknown ||
        snapshot == null ||
        (!revoke &&
            (team == null || (audience == 'selected' && members.isEmpty)))) {
      return;
    }
    await transport.owner(transport.scope.workspaceId);
    final body = <String, dynamic>{
      'requestId': requestId(),
      'expectedRevision': share?['revision'] ?? 'unset',
      if (!revoke) ...{
        'targetTeamId': teamId,
        'audience': audience,
        'memberIds': audience == 'selected' ? (members.toList()..sort()) : [],
        if (filesChanged) 'files': selectedFiles.map(fileGrant).toList(),
        if (appsChanged) 'apps': selectedApps.map(appGrant).toList(),
      },
    };
    await recovery.claim(
      revoke ? 'shareRevoke' : 'shareUpdate',
      transport.scope.workspaceId,
      agentId,
      body,
    );
    try {
      sharingSnapshot(
        await transport.send(
          revoke ? 'POST' : 'PUT',
          revoke ? '$path/revoke' : path,
          body: body,
        ),
        transport.scope.workspaceId,
        agentId,
      );
      await load();
      await recovery.clear(recovery.value!);
    } on ApiException catch (e) {
      if ([400, 409, 413, 422].contains(e.status) &&
          e.code == 'SHARED_BOT_NOT_APPLIED') {
        await recovery.clear(recovery.value!);
      }
      rethrow;
    }
  });
  Future<void> acknowledge() => work(() async {
    if (!unknown) return;
    await load();
    await recovery.clear(recovery.value!);
  });
  @override
  void dispose() {
    closed = true;
    transport.scope.session.removeListener(changed);
    transport.close();
    super.dispose();
  }
}

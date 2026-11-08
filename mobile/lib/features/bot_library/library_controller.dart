import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import 'library_data.dart';
import 'library_installer.dart';
import 'library_transport.dart';
import 'sharing_data.dart';

class LibraryController extends ChangeNotifier {
  LibraryController(WorkspaceController scope)
    : transport = LibraryTransport(scope) {
    installer = LibraryInstaller(transport)..addListener(changed);
    scope.session.addListener(changed);
  }
  final LibraryTransport transport;
  late final LibraryInstaller installer;
  List<Json> workspaces = [], items = [];
  List<Json> sharedFiles = [], sharedApps = [];
  Json? sharedAppTools;
  Json? selected;
  String kind = 'templates',
      query = '',
      targetId = '',
      name = '',
      routineMode = 'pause';
  String? error;
  bool loading = false, closed = false;
  int sequence = 0;
  bool get active => !closed && transport.active;
  bool get locked => installer.pending != null || installer.busy;
  Json? get target => workspaces
      .where(
        (w) =>
            w['id'] == targetId &&
            w['role'] == 'owner' &&
            (kind != 'shared' || w['kind'] == 'personal'),
      )
      .firstOrNull;
  List<Json> get targets => workspaces
      .where(
        (w) =>
            w['role'] == 'owner' &&
            (kind != 'shared' || w['kind'] == 'personal'),
      )
      .toList();
  void changed() {
    if (!closed) notifyListeners();
  }

  Future<void> initialize() async {
    try {
      workspaces = await transport.account();
      if (!active) return;
      targetId =
          targets
              .where((w) => w['id'] == transport.scope.workspaceId)
              .firstOrNull?['id'] ??
          targets.firstOrNull?['id'] ??
          '';
      await installer.initialize();
      if (active && installer.pending == null) await refresh();
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    }
    changed();
  }

  void chooseKind(String value) {
    if (!active || locked || !{'templates', 'shared'}.contains(value)) return;
    sequence++;
    loading = false;
    kind = value;
    selected = null;
    items = [];
    query = '';
    error = null;
    if (target == null) targetId = targets.firstOrNull?['id'] ?? '';
    changed();
  }

  void chooseTarget(String id) {
    if (!active || locked || !targets.any((w) => w['id'] == id)) return;
    sequence++;
    loading = false;
    targetId = id;
    selected = null;
    items = [];
    error = null;
    changed();
  }

  void search(String value) {
    if (!active || locked) return;
    sequence++;
    loading = false;
    query = value.length > 120 ? value.substring(0, 120) : value;
    changed();
  }

  Future<void> refresh() async {
    if (!active || locked) return;
    final order = ++sequence;
    loading = true;
    error = null;
    changed();
    try {
      final path = kind == 'templates'
          ? '/api/bot-template-gallery?query=${Uri.encodeQueryComponent(query.trim())}'
          : '/api/shared-bots${target == null ? '' : '?personalWorkspaceId=${Uri.encodeQueryComponent(targetId)}'}';
      final data = libraryRows(await transport.send('GET', path));
      if (!active || order != sequence) return;
      if (kind == 'templates') {
        if (data.any(
          (d) =>
              !templateToken(d['token']) ||
              !libraryText(d['name'], 40, empty: false) ||
              !libraryText(d['role'], 80, empty: false) ||
              !{'public', 'team'}.contains(d['audience']),
        )) {
          invalidLibrary();
        }
        items = data;
      } else {
        final needle = query.trim().toLowerCase();
        items = data
            .map(sharedCard)
            .where(
              (d) =>
                  needle.isEmpty ||
                  '${d['name']} ${d['role']} ${d['description']}'
                      .toLowerCase()
                      .contains(needle),
            )
            .toList();
      }
    } catch (e) {
      if (active && order == sequence) {
        error = e is ApiException ? e.message : 'requestFailed';
      }
    } finally {
      if (active && order == sequence) {
        loading = false;
        changed();
      }
    }
  }

  Future<void> preview(Json item) async {
    if (!active || locked) return;
    final order = ++sequence;
    loading = true;
    selected = null;
    error = null;
    changed();
    try {
      final shared = kind == 'shared', id = shared ? item['id'] : item['token'];
      if (shared ? !libraryId(id) : !templateToken(id)) invalidLibrary();
      final value = await transport.send(
        'GET',
        shared ? '/api/shared-bots/$id' : '/api/bot-template-links/$id',
      );
      if (!active || order != sequence) return;
      final next = shared ? sharedCard(value) : publishedTemplate(value);
      if (next[shared ? 'id' : 'token'] != id) invalidLibrary();
      final files = shared && (next['fileCount'] as int? ?? 0) > 0
          ? libraryRows(
              await transport.send('GET', '/api/shared-bots/$id/files'),
            ).map(sharedFile).toList()
          : <Json>[];
      final apps = shared && (next['appCount'] as int? ?? 0) > 0
          ? libraryRows(
              await transport.send('GET', '/api/shared-bots/$id/apps'),
            ).map(sharedApp).toList()
          : <Json>[];
      if (!active || order != sequence) return;
      selected = next;
      sharedFiles = files;
      sharedApps = apps;
      sharedAppTools = null;
      name = shared ? next['name'] : next['blueprint']['profile']['name'];
      routineMode = 'pause';
    } catch (e) {
      if (active && order == sequence) {
        error = e is ApiException ? e.message : 'requestFailed';
      }
    } finally {
      if (active && order == sequence) {
        loading = false;
        changed();
      }
    }
  }

  Future<void> inspectSharedApp(String id) async {
    if (!active ||
        locked ||
        loading ||
        selected == null ||
        kind != 'shared' ||
        !sharedApps.any(
          (a) => a['connectionId'] == id && a['status'] == 'available',
        )) {
      return;
    }
    final order = ++sequence;
    loading = true;
    error = null;
    sharedAppTools = null;
    changed();
    try {
      final value = sharedApp(
        await transport.send(
          'GET',
          '/api/shared-bots/${selected!['id']}/apps/$id/tools',
        ),
        schema: true,
      );
      if (!active || order != sequence) return;
      if (value['connectionId'] != id) invalidLibrary();
      sharedAppTools = value;
    } catch (e) {
      if (active && order == sequence) {
        error = e is ApiException ? e.message : 'requestFailed';
      }
    } finally {
      if (active && order == sequence) {
        loading = false;
        changed();
      }
    }
  }

  void closePreview() {
    if (!locked) {
      sequence++;
      selected = null;
      loading = false;
      changed();
    }
  }

  Future<void> install() async {
    if (!active || locked || loading || target == null || selected == null) {
      return;
    }
    final shared = kind == 'shared', selection = selected!;
    await installer.start(
      kind: shared ? 'join' : 'import',
      workspaceId: targetId,
      sourceId: selection[shared ? 'id' : 'token'],
      expectedRevision: shared ? null : selection['revision'],
      name: name,
      routineMode: routineMode,
    );
  }

  @override
  void dispose() {
    closed = true;
    sequence++;
    installer.removeListener(changed);
    installer.dispose();
    transport.scope.session.removeListener(changed);
    transport.close();
    super.dispose();
  }
}

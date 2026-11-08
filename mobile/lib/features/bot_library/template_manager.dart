import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/workspace_controller.dart';
import 'library_data.dart';
import 'library_installer.dart';
import 'library_transport.dart';
import 'template_operation.dart';

class TemplateManager extends ChangeNotifier {
  TemplateManager(WorkspaceController scope)
    : transport = LibraryTransport(scope) {
    operation = TemplateOperation(transport)..addListener(changed);
    installer = LibraryInstaller(transport)..addListener(changed);
    scope.session.addListener(changed);
  }
  final LibraryTransport transport;
  late final TemplateOperation operation;
  late final LibraryInstaller installer;
  List<Json> bots = [], templates = [];
  Json? source, selected;
  String? sourceId, conversationId, error;
  bool busy = false, closed = false;
  int sequence = 0;
  bool get active => !closed && transport.active;
  bool get locked =>
      busy || operation.locked || installer.pending != null || installer.busy;
  String get base =>
      transport.workspacePath(transport.scope.workspaceId, '/bot-templates');
  void changed() {
    if (!closed) notifyListeners();
  }

  Future<void> work(Future<void> Function(int order) action) async {
    if (!active || busy) return;
    busy = true;
    error = null;
    final order = ++sequence;
    changed();
    try {
      await action(order);
    } catch (e) {
      if (active && order == sequence) {
        error = e is ApiException ? e.message : 'requestFailed';
      }
    } finally {
      if (active && order == sequence) {
        busy = false;
        changed();
      }
    }
  }

  Future<void> initialize() => work((_) async {
    await transport.owner(transport.scope.workspaceId);
    await operation.initialize();
    await installer.initialize();
    if (active && operation.pending == null && installer.pending == null) {
      await load();
    }
  });
  Future<void> load() async {
    await transport.owner(transport.scope.workspaceId);
    await transport.scope.refresh();
    transport.guard();
    bots = transport.scope
        .items('agents')
        .where((b) => !isManagedBot(b))
        .toList();
    final rows = libraryRows(await transport.send('GET', base));
    templates = rows.map(ownedTemplate).toList();
  }

  Future<void> refresh() => work((_) async {
    if (operation.pending != null || installer.pending != null) return;
    await load();
    if (selected != null) {
      selected = templates.where((t) => t['id'] == selected!['id']).firstOrNull;
    }
  });
  Future<void> previewSource(String id) => work((order) async {
    if (operation.pending != null ||
        installer.pending != null ||
        !libraryId(id)) {
      return;
    }
    await transport.owner(transport.scope.workspaceId);
    await transport.scope.refresh();
    transport.guard();
    final bot = transport.scope.find('agents', id);
    if (bot == null || isManagedBot(bot)) invalidLibrary();
    final chats = transport.scope
        .items('conversations')
        .where(
          (c) =>
              c['isGroup'] == false &&
              c['agentIds'] is List &&
              (c['agentIds'] as List).length == 1 &&
              (c['agentIds'] as List).single == id,
        )
        .toList();
    final value = sourceBlueprint(
      await transport.send(
        'GET',
        transport.workspacePath(
          transport.scope.workspaceId,
          '/bot-copy-source/$id',
        ),
      ),
    );
    if (!active || order != sequence) return;
    sourceId = id;
    conversationId = chats.length == 1 ? chats.single['id'] : null;
    source = value;
    selected = null;
  });
  Future<void> previewTemplate(String id) => work((order) async {
    if (operation.pending != null ||
        installer.pending != null ||
        !libraryId(id)) {
      return;
    }
    await transport.owner(transport.scope.workspaceId);
    final value = ownedTemplate(await transport.send('GET', '$base/$id'));
    if (value['id'] != id) invalidLibrary();
    if (!active || order != sequence) return;
    selected = value;
    source = null;
    sourceId = null;
    conversationId = null;
  });
  Future<void> copy(String name, String routineMode) async {
    if (!active || locked || source == null || sourceId == null) return;
    await installer.start(
      kind: 'copy',
      workspaceId: transport.scope.workspaceId,
      sourceId: sourceId!,
      expectedRevision: source!['sourceRevision'],
      name: name,
      routineMode: routineMode,
    );
  }

  Future<void> create() async {
    if (!active ||
        locked ||
        source == null ||
        sourceId == null ||
        conversationId == null) {
      return;
    }
    await operation.start('Create', sourceId!, {
      'sourceAgentId': sourceId,
      'sourceConversationId': conversationId,
      'expectedSourceRevision': source!['sourceRevision'],
    });
  }

  Future<void> change(String kind, {Json? draft, String? audience}) async {
    if (!active || locked || selected == null) return;
    await work((_) async {
      final t = selected!;
      final input = <String, dynamic>{'expectedRevision': t['revision']};
      if (kind == 'Edit' || kind == 'Publish') {
        input['expectedDraftRevision'] = t['draftRevision'];
      }
      if (kind == 'Edit') input['blueprint'] = blueprint(draft);
      if (kind == 'Publish') input['audience'] = audience;
      if (kind == 'Refresh') {
        final value = sourceBlueprint(
          await transport.send(
            'GET',
            transport.workspacePath(
              transport.scope.workspaceId,
              '/bot-copy-source/${t['sourceAgentId']}',
            ),
          ),
        );
        transport.guard();
        // Refresh must capture the source explicitly reviewed on this page.
        if (source == null ||
            sourceId != t['sourceAgentId'] ||
            value['sourceRevision'] != source!['sourceRevision']) {
          error = 'mobileLibrarySourceChanged';
          changed();
          return;
        }
        input['expectedSourceRevision'] = source!['sourceRevision'];
      }
      await operation.start(kind, t['id'], input);
    });
  }

  Future<void> previewRefresh() => work((_) async {
    if (operation.pending != null ||
        installer.pending != null ||
        selected == null) {
      return;
    }
    final id = selected!['sourceAgentId'];
    await transport.owner(transport.scope.workspaceId);
    final value = sourceBlueprint(
      await transport.send(
        'GET',
        transport.workspacePath(
          transport.scope.workspaceId,
          '/bot-copy-source/$id',
        ),
      ),
    );
    sourceId = id;
    source = value;
  });
  Future<void> finish() async {
    if (!await operation.finish() || !active) return;
    selected = null;
    source = null;
    sourceId = null;
    conversationId = null;
    await refresh();
  }

  @override
  void dispose() {
    closed = true;
    sequence++;
    operation.removeListener(changed);
    operation.dispose();
    installer.removeListener(changed);
    installer.dispose();
    transport.scope.session.removeListener(changed);
    transport.close();
    super.dispose();
  }
}

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'roster_controller.dart';
import 'roster_data.dart';
import 'roster_dialogs.dart';
import 'roster_conversation.dart';

class RosterScreen extends StatefulWidget {
  const RosterScreen({super.key, required this.scope, this.onOpen});
  final WorkspaceController scope;
  final void Function(String)? onOpen;
  @override
  State<RosterScreen> createState() => _RosterScreenState();
}

class _RosterScreenState extends State<RosterScreen> {
  late final model = RosterController(widget.scope)..initialize();
  @override
  void dispose() {
    model.dispose();
    super.dispose();
  }

  Future<void> _section(String action, [Json? section]) async {
    if (!model.editable) return;
    final id = section?['id'];
    if (action == 'delete') {
      if (!await rosterConfirm(context, 'mobileRosterDeleteConfirm')) return;
      await model.update({'type': 'delete-section', 'id': id});
    } else if (action == 'collapse') {
      await model.update({
        'type': 'set-section-collapsed',
        'id': id,
        'collapsed': section!['collapsed'] != true,
      });
    } else {
      final name = await rosterName(
        context,
        value: section?['name'] as String? ?? '',
      );
      if (name == null || !model.active) return;
      await model.update({
        'type': id == null ? 'create-section' : 'rename-section',
        'id': ?id,
        'name': name,
      });
    }
  }

  Future<void> _entry(String action, Json chat) async {
    if (!model.editable) return;
    final entry = rosterEntry(chat, model.state);
    final changes = <String, dynamic>{};
    if (action == 'move') {
      final destination = await rosterDestination(
        context,
        (model.state?['sections'] as List? ?? []).whereType<Json>().toList(),
      );
      if (destination == null || !model.active) return;
      changes['sectionId'] = destination.isEmpty ? null : destination;
    } else if (action == 'pin') {
      changes['pinned'] = entry['pinned'] != true;
    } else {
      changes['hidden'] = entry['hidden'] != true;
    }
    await model.update({
      'type': 'set-entry',
      'target': rosterTarget(chat),
      ...changes,
    });
  }

  void _open(String id) {
    if (!model.active || widget.onOpen == null) return;
    Navigator.pop(context);
    widget.onOpen!(id);
  }

  Widget _chat(Json chat, {bool primary = false}) {
    final entry = rosterEntry(chat, model.state);
    return RosterConversation(
      scope: widget.scope,
      conversation: chat,
      primary: primary,
      onOpen: widget.onOpen == null ? null : _open,
      trailing: PopupMenuButton<String>(
        enabled: model.editable,
        tooltip: context.tr('mobileRosterActions'),
        onSelected: (action) => _entry(action, chat),
        itemBuilder: (_) => [
          PopupMenuItem(
            value: 'pin',
            child: Text(
              context.tr(
                entry['pinned'] == true
                    ? 'mobileRosterUnpin'
                    : 'mobileRosterPin',
              ),
            ),
          ),
          PopupMenuItem(
            value: 'move',
            child: Text(context.tr('mobileRosterMove')),
          ),
          PopupMenuItem(
            value: 'hidden',
            child: Text(
              context.tr(
                entry['hidden'] == true
                    ? 'mobileRosterRestore'
                    : 'mobileRosterHide',
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([model, widget.scope]),
    builder: (context, _) {
      final projection = RosterProjection(
        widget.scope.data ?? {},
        state: model.state,
      );
      return Scaffold(
        appBar: AppBar(
          title: Text(context.tr('mobileRosterTitle')),
          actions: [
            IconButton(
              tooltip: context.tr('mobileRosterCheck'),
              onPressed: model.busy ? null : model.initialize,
              icon: const Icon(Icons.refresh),
            ),
            IconButton(
              tooltip: context.tr('mobileRosterNewSection'),
              onPressed: model.editable ? () => _section('create') : null,
              icon: const Icon(Icons.create_new_folder_outlined),
            ),
          ],
        ),
        body: !model.ready
            ? Center(
                child: model.error == null
                    ? const CircularProgressIndicator()
                    : Notice(
                        model.error!,
                        action: 'retry',
                        onAction: model.initialize,
                      ),
              )
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  const Notice('mobileRosterPersonal'),
                  if (model.error != null) Notice(model.error!),
                  if (model.busy) const LinearProgressIndicator(),
                  if (model.pending != null)
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(context.tr('mobileRosterUnknown')),
                            TextButton(
                              onPressed: model.busy ? null : model.check,
                              child: Text(context.tr('mobileRosterCheck')),
                            ),
                            if (model.checked)
                              OutlinedButton(
                                onPressed: model.busy
                                    ? null
                                    : () async {
                                        if (await rosterConfirm(
                                          context,
                                          'mobileRosterAcknowledgeConfirm',
                                        )) {
                                          await model.acknowledge();
                                        }
                                      },
                                child: Text(
                                  context.tr('mobileRosterAcknowledge'),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  if (projection.standalone != null)
                    _chat(projection.standalone!, primary: true),
                  if (projection.pinned.isNotEmpty)
                    ListTile(title: Text(context.tr('mobileRosterPinned'))),
                  for (final chat in projection.pinned)
                    _chat(
                      chat,
                      primary: chat['id'] == projection.primary?['id'],
                    ),
                  for (final section in projection.sections) ...[
                    ListTile(
                      title: Text(section.value['name'] as String),
                      leading: Icon(
                        section.value['collapsed'] == true
                            ? Icons.expand_more
                            : Icons.expand_less,
                      ),
                      onTap: model.editable
                          ? () => _section('collapse', section.value)
                          : null,
                      trailing: PopupMenuButton<String>(
                        enabled: model.editable,
                        tooltip: context.tr('mobileRosterSectionActions'),
                        onSelected: (action) => _section(action, section.value),
                        itemBuilder: (_) => [
                          PopupMenuItem(
                            value: 'rename',
                            child: Text(context.tr('mobileRosterRename')),
                          ),
                          PopupMenuItem(
                            value: 'delete',
                            child: Text(context.tr('delete')),
                          ),
                        ],
                      ),
                    ),
                    if (section.value['collapsed'] != true)
                      for (final chat in section.conversations)
                        _chat(
                          chat,
                          primary: chat['id'] == projection.primary?['id'],
                        ),
                  ],
                  if (projection.ungrouped.isNotEmpty)
                    ListTile(title: Text(context.tr('mobileRosterOther'))),
                  for (final chat in projection.ungrouped) _chat(chat),
                  if (projection.hidden.isNotEmpty) ...[
                    ListTile(title: Text(context.tr('mobileRosterHidden'))),
                    for (final chat in projection.hidden)
                      _chat(
                        chat,
                        primary: chat['id'] == projection.primary?['id'],
                      ),
                  ],
                  if (projection.empty && projection.hidden.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(context.tr('noChats')),
                    ),
                ],
              ),
      );
    },
  );
}

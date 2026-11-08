import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'roster_controller.dart';
import 'roster_conversation.dart';
import 'roster_data.dart';
import 'roster_screen.dart';

class RosterList extends StatefulWidget {
  const RosterList({super.key, required this.scope, required this.onOpen});
  final WorkspaceController scope;
  final void Function(String) onOpen;

  @override
  State<RosterList> createState() => _RosterListState();
}

class _RosterListState extends State<RosterList> {
  RosterController? model;
  bool busy = false;
  String? error;
  WorkspaceController get scope => widget.scope;
  void Function(String) get onOpen => widget.onOpen;

  @override
  void didUpdateWidget(RosterList old) {
    super.didUpdateWidget(old);
    if (!identical(old.scope, scope)) {
      model?.dispose();
      model = null;
      busy = false;
      error = null;
    }
  }

  Future<void> _toggle(Json section) async {
    if (busy || !scope.active) return;
    final controller = model ??= RosterController(scope);
    setState(() {
      busy = true;
      error = null;
    });
    await controller.initialize();
    if (!mounted || !identical(controller, model) || !controller.active) return;
    if (controller.editable) {
      await controller.update({
        'type': 'set-section-collapsed',
        'id': section['id'],
        'collapsed': section['collapsed'] != true,
      });
    }
    if (mounted && identical(controller, model) && controller.active) {
      setState(() {
        busy = false;
        error = controller.pending != null
            ? 'mobileRosterUnknown'
            : controller.error;
      });
    }
  }

  @override
  void dispose() {
    model?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final projection = RosterProjection(scope.data ?? {});
    void manage() => Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => RosterScreen(scope: scope, onOpen: onOpen),
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (busy) const LinearProgressIndicator(),
        if (error != null) Notice(error!),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton.icon(
            onPressed: scope.active ? manage : null,
            icon: const Icon(Icons.view_list_outlined),
            label: Text(context.tr('mobileRosterTitle')),
          ),
        ),
        if (projection.standalone != null)
          RosterConversation(
            scope: scope,
            conversation: projection.standalone!,
            primary: true,
            onOpen: onOpen,
          ),
        if (projection.pinned.isNotEmpty)
          _heading(context, 'mobileRosterPinned'),
        for (final chat in projection.pinned)
          RosterConversation(
            scope: scope,
            conversation: chat,
            onOpen: onOpen,
            primary: chat['id'] == projection.primary?['id'],
          ),
        for (final section in projection.sections) ...[
          ListTile(
            title: Text(section.value['name'] as String),
            trailing: Icon(
              section.value['collapsed'] == true
                  ? Icons.expand_more
                  : Icons.expand_less,
            ),
            onTap: busy ? null : () => _toggle(section.value),
          ),
          if (section.value['collapsed'] != true)
            for (final chat in section.conversations)
              RosterConversation(
                scope: scope,
                conversation: chat,
                onOpen: onOpen,
                primary: chat['id'] == projection.primary?['id'],
              ),
        ],
        if (projection.sections.isNotEmpty && projection.ungrouped.isNotEmpty)
          _heading(context, 'mobileRosterOther'),
        for (final chat in projection.ungrouped)
          RosterConversation(scope: scope, conversation: chat, onOpen: onOpen),
        if (projection.empty)
          Padding(
            padding: const EdgeInsets.all(24),
            child: Text(context.tr('noChats')),
          ),
        if (projection.hidden.isNotEmpty)
          TextButton.icon(
            onPressed: manage,
            icon: const Icon(Icons.visibility_off_outlined),
            label: Text(
              '${context.tr('mobileRosterHidden')} (${projection.hidden.length})',
            ),
          ),
      ],
    );
  }

  Widget _heading(BuildContext context, String key) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 20, 12, 8),
    child: Text(context.tr(key), style: Theme.of(context).textTheme.titleSmall),
  );
}

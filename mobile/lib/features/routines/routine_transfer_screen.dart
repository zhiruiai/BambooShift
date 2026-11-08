import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/routine_operation_data.dart';
import '../../core/routine_public_search.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import '../../widgets/common.dart';
import 'routine_transfer_controller.dart';
import 'routine_transfer_data.dart';

class RoutineTransferScreen extends StatefulWidget {
  const RoutineTransferScreen({
    super.key,
    required this.scope,
    required this.routine,
  });
  final WorkspaceController scope;
  final Json routine;
  @override
  State<RoutineTransferScreen> createState() => _RoutineTransferScreenState();
}

class _RoutineTransferScreenState extends State<RoutineTransferScreen> {
  late final RoutineTransferController controller;
  late Json reviewed;
  String? selected;
  @override
  void initState() {
    super.initState();
    reviewed = cloneRoutineData(widget.routine);
    controller = RoutineTransferController(widget.scope, reviewed['id']);
    unawaited(controller.initialize());
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> finish() async {
    if (await controller.finish() && mounted && controller.active) {
      Navigator.pop(context);
    }
  }

  Future<void> transfer(Json chosen) async {
    if (controller.locked ||
        !await confirm(
          context,
          '${context.tr('mobileWorkspaceTransferConfirm')}\n${chosen['agent']['name']}',
        )) {
      return;
    }
    if (!mounted || !controller.active) return;
    await controller.start(reviewed, chosen);
  }

  Future<void> cancel() async {
    if (!await confirm(context, 'mobileWorkspaceTransferCancelConfirm')) return;
    if (mounted && controller.active) await controller.cancel();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      controller,
      widget.scope,
      widget.scope.session,
    ]),
    builder: (context, _) {
      final c = controller, scope = widget.scope;
      if (!c.active) return const Scaffold(body: Notice('scopeChanged'));
      final current = scope.find('routines', c.routineId);
      final changed = current == null || !sameRoutineConfig(current, reviewed);
      final choices = transferTargets(
        scope,
        reviewed['agentId'] as String? ?? '',
      );
      final chosen = choices
          .where((v) => v['agent']['id'] == selected)
          .firstOrNull;
      final receipt = c.receipt;
      return Scaffold(
        appBar: AppBar(title: Text(context.tr('mobileWorkspaceTransferTitle'))),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              reviewed['title'] as String? ??
                  context.tr('mobileWorkspaceTransferOriginal'),
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const Notice('mobileWorkspaceTransferScope'),
            const Notice('mobileWorkspaceTransferPreserves'),
            const Notice('routineWebhookTransferClears'),
            if (normalizeRoutinePublicQueries(
                  reviewed[routinePublicSearchField],
                )?.isNotEmpty ==
                true)
              const Notice('routinePublicSearchTransferClears'),
            if (c.busy) const LinearProgressIndicator(),
            if (c.error != null) Notice(c.error!),
            if (c.notice != null) Notice(c.notice!),
            if (receipt != null) ...[
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(context.tr('mobileWorkspaceTransferRecipient')),
                subtitle: Text(
                  scope.find('agents', receipt['targetAgentId'])?['name']
                          as String? ??
                      context.tr('mobileWorkspaceTransferRecipientMissing'),
                ),
              ),
              Notice(
                receipt['status'] == 'missing'
                    ? 'mobileWorkspaceTransferMissing'
                    : receipt['routine']['agentId'] ==
                              receipt['targetAgentId'] &&
                          receipt['routine']['conversationId'] ==
                              receipt['targetConversationId']
                    ? 'mobileWorkspaceTransferDone'
                    : 'mobileWorkspaceTransferLaterChanged',
              ),
              FilledButton(
                onPressed: c.busy ? null : finish,
                child: Text(context.tr('done')),
              ),
            ] else if (c.pending != null) ...[
              const Notice('mobileWorkspaceTransferUnknown'),
              TextButton(
                onPressed: c.busy ? null : c.check,
                child: Text(context.tr('mobileWorkspaceTransferCheck')),
              ),
              if (scope.owner)
                TextButton(
                  onPressed: c.busy ? null : cancel,
                  child: Text(context.tr('mobileWorkspaceTransferCancel')),
                ),
            ] else ...[
              if (changed) ...[
                const Notice('mobileWorkspaceTransferChanged'),
                if (current != null)
                  TextButton(
                    onPressed: c.busy
                        ? null
                        : () => setState(() {
                            reviewed = cloneRoutineData(current);
                            selected = null;
                          }),
                    child: Text(context.tr('mobileWorkspaceTransferReload')),
                  ),
              ],
              if (!canTransferRoutine(scope, reviewed))
                const Notice('mobileWorkspaceTransferUnavailable'),
              if (choices.isEmpty)
                const Notice('mobileWorkspaceTransferNoTargets'),
              for (final choice in choices)
                Card(
                  child: ListTile(
                    leading: BotAvatar(
                      bot: choice['agent'] as Json,
                      family: scope.session.avatarTheme,
                      size: 40,
                    ),
                    title: Text(choice['agent']['name'] as String? ?? ''),
                    subtitle: Text(
                      choice['conversation']['title'] as String? ?? '',
                    ),
                    trailing: Icon(
                      selected == choice['agent']['id']
                          ? Icons.radio_button_checked
                          : Icons.radio_button_off,
                    ),
                    selected: selected == choice['agent']['id'],
                    onTap:
                        c.locked ||
                            changed ||
                            !canTransferRoutine(scope, reviewed)
                        ? null
                        : () => setState(
                            () => selected = choice['agent']['id'] as String,
                          ),
                  ),
                ),
              const Notice('mobileWorkspaceTransferIdle'),
              FilledButton(
                onPressed:
                    c.locked ||
                        changed ||
                        chosen == null ||
                        !canTransferRoutine(scope, reviewed)
                    ? null
                    : () => transfer(chosen),
                child: Text(context.tr('mobileWorkspaceTransferAction')),
              ),
            ],
          ],
        ),
      );
    },
  );
}

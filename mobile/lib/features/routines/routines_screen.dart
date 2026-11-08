import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/routine_operation_controller.dart';
import '../../core/routine_operation_data.dart';
import '../../core/routine_public_search.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'routine_editor.dart';
import 'routine_history.dart';
import 'routine_operation_panel.dart';
import 'routine_transfer_data.dart';
import 'routine_transfer_recovery.dart';
import 'routine_transfer_screen.dart';
import 'routine_webhook_data.dart';
import 'routine_webhook_screen.dart';

class RoutinesScreen extends StatefulWidget {
  const RoutinesScreen({super.key, required this.scope, required this.agentId});
  final WorkspaceController scope;
  final String agentId;
  @override
  State<RoutinesScreen> createState() => _RoutinesScreenState();
}

class _RoutinesScreenState extends State<RoutinesScreen> {
  String? error, busy;
  late final RoutineOperationController operation;
  @override
  void initState() {
    super.initState();
    operation = RoutineOperationController(widget.scope, widget.agentId);
    unawaited(operation.initialize());
  }

  @override
  void dispose() {
    operation.dispose();
    super.dispose();
  }

  Future<void> run(Json routine) async {
    final reviewed = cloneRoutineData(routine);
    if (busy != null ||
        operation.locked ||
        !await confirm(
          context,
          routine['schedule'] == 'webhook'
              ? 'routineWebhookManualConfirm'
              : 'runNowConfirm',
        )) {
      return;
    }
    if (!mounted || !widget.scope.active || !_current(reviewed)) return;
    await operation.run(reviewed);
    if (mounted && widget.scope.active) await widget.scope.refresh();
  }

  Future<void> remove(Json routine) async {
    final reviewed = cloneRoutineData(routine);
    if (busy != null ||
        operation.locked ||
        !await confirm(context, 'deleteRoutineConfirm')) {
      return;
    }
    if (!mounted ||
        !widget.scope.active ||
        operation.locked ||
        !_current(reviewed)) {
      return;
    }
    setState(() {
      busy = routine['id'] as String;
      error = null;
    });
    try {
      await widget.scope.request(
        'DELETE',
        '/routines/${routine['id']}',
        body: {'expectedRoutine': routineConfig(reviewed)},
      );
      await widget.scope.refresh();
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (mounted) setState(() => busy = null);
    }
  }

  bool _current(Json reviewed) {
    final current = widget.scope.find('routines', reviewed['id'] as String);
    if (current != null && sameRoutineConfig(current, reviewed)) return true;
    setState(() => error = 'routineReviewedChanged');
    return false;
  }

  Future<void> edit([Json? routine]) async {
    if (operation.locked || busy != null) return;
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => RoutineEditor(
          scope: widget.scope,
          agentId: widget.agentId,
          routine: routine,
          operation: routine == null ? operation : null,
        ),
      ),
    );
    if (mounted) await widget.scope.refresh();
  }

  Future<void> history(String id) => Navigator.push(
    context,
    MaterialPageRoute<void>(
      builder: (_) => RoutineHistory(scope: widget.scope, routineId: id),
    ),
  );

  Future<void> webhook(Json routine) async {
    final scope = widget.scope;
    if (busy != null ||
        operation.locked ||
        !canManageRoutineWebhook(scope, routine)) {
      return;
    }
    await Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => RoutineWebhookScreen(
          scope: scope,
          routineId: routine['id'] as String,
          agentId: routine['agentId'] as String,
          conversationId: routine['conversationId'] as String,
        ),
      ),
    );
  }

  Future<void> transfer(Json routine) async {
    if (busy != null ||
        operation.locked ||
        !canTransferRoutine(widget.scope, routine)) {
      return;
    }
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) =>
            RoutineTransferScreen(scope: widget.scope, routine: routine),
      ),
    );
    if (mounted && widget.scope.active) await widget.scope.refresh();
  }

  String next(Json routine) {
    if (routine['enabled'] != true) return context.tr('paused');
    if (routine['schedule'] == 'webhook') return '';
    final at = DateTime.tryParse(routine['nextRunAt'] as String? ?? '');
    return at == null
        ? ''
        : '${context.tr('nextRun')} ${DateFormat.yMd(Localizations.localeOf(context).languageCode).add_Hm().format(at.toLocal())}';
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      widget.scope,
      widget.scope.session,
      operation,
    ]),
    builder: (context, _) {
      final rows = widget.scope
          .items('routines')
          .where((r) => r['agentId'] == widget.agentId)
          .toList();
      final bot = widget.scope.find('agents', widget.agentId);
      final editable = widget.scope.active && widget.scope.owner && bot != null;
      final available = botAvailable(bot);
      final idle = busy == null && !operation.locked;
      return Scaffold(
        appBar: AppBar(
          title: Text(context.tr('routines')),
          actions: [
            if (editable)
              IconButton(
                tooltip: context.tr('newRoutine'),
                onPressed: idle && available ? () => edit() : null,
                icon: const Icon(Icons.add),
              ),
          ],
        ),
        body: RefreshIndicator(
          onRefresh: widget.scope.refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [
              if (error != null) Notice(error!),
              RoutineTransferRecovery(scope: widget.scope),
              RoutineOperationPanel(controller: operation, onHistory: history),
              if (rows.isEmpty) const Notice('noRoutines'),
              for (final routine in rows)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          routine['title'] as String? ?? '',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 8),
                        Text(routine['prompt'] as String? ?? ''),
                        const SizedBox(height: 12),
                        Text(
                          routine['schedule'] == 'webhook'
                              ? context.tr('routineWebhookOnly')
                              : '${routine['schedule']} · ${routine['timeZone'] ?? 'Asia/Shanghai'}',
                        ),
                        if (next(routine) case final nextRun
                            when nextRun.isNotEmpty)
                          Text(nextRun),
                        if (normalizeRoutinePublicQueries(
                              routine[routinePublicSearchField],
                            )?.isNotEmpty ==
                            true)
                          Text(context.tr('routinePublicSearchApproved')),
                        Wrap(
                          spacing: 8,
                          children: [
                            if (editable)
                              TextButton(
                                onPressed: idle ? () => edit(routine) : null,
                                child: Text(context.tr('edit')),
                              ),
                            if (canTransferRoutine(widget.scope, routine))
                              TextButton(
                                onPressed: idle
                                    ? () => transfer(routine)
                                    : null,
                                child: Text(
                                  context.tr('mobileWorkspaceTransferAction'),
                                ),
                              ),
                            if (canManageRoutineWebhook(widget.scope, routine))
                              TextButton(
                                onPressed: idle ? () => webhook(routine) : null,
                                child: Text(context.tr('routineWebhookTitle')),
                              ),
                            TextButton(
                              onPressed: busy == null
                                  ? () => history(routine['id'] as String)
                                  : null,
                              child: Text(context.tr('runHistory')),
                            ),
                            if (editable)
                              TextButton(
                                onPressed: idle && available
                                    ? () => run(routine)
                                    : null,
                                child: Text(context.tr('runNow')),
                              ),
                            if (editable)
                              IconButton(
                                tooltip: context.tr('delete'),
                                onPressed: idle ? () => remove(routine) : null,
                                icon: const Icon(Icons.delete_outline),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );
}

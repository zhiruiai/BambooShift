import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../widgets/common.dart';
import 'routine_transfer_data.dart';
import 'routine_transfer_screen.dart';

class RoutineTransferRecovery extends StatefulWidget {
  const RoutineTransferRecovery({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<RoutineTransferRecovery> createState() =>
      _RoutineTransferRecoveryState();
}

class _RoutineTransferRecoveryState extends State<RoutineTransferRecovery> {
  Json? pending;
  String? error;
  int generation = 0;
  @override
  void initState() {
    super.initState();
    widget.scope.addListener(reload);
    widget.scope.session.addListener(reload);
    reload();
  }

  void reload() {
    unawaited(read());
  }

  Future<void> read() async {
    final ticket = ++generation;
    try {
      final value = await readTransferRecovery(widget.scope);
      if (mounted && widget.scope.active && ticket == generation) {
        setState(() {
          pending = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted && ticket == generation) {
        setState(() {
          pending = null;
          error = widget.scope.active
              ? (e is ApiException ? e.message : 'requestFailed')
              : null;
        });
      }
    }
  }

  Future<void> open() async {
    if (!widget.scope.active || pending == null) return;
    final saved = pending!;
    final routine =
        widget.scope.find('routines', saved['routineId']) ??
        <String, dynamic>{
          'id': saved['routineId'],
          'agentId': saved['sourceAgentId'],
          'conversationId': saved['sourceConversationId'],
        };
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) =>
            RoutineTransferScreen(scope: widget.scope, routine: routine),
      ),
    );
    if (mounted && widget.scope.active) await read();
  }

  @override
  void dispose() {
    generation++;
    widget.scope.removeListener(reload);
    widget.scope.session.removeListener(reload);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => !widget.scope.active
      ? const SizedBox.shrink()
      : error != null
      ? Notice(error!)
      : pending == null
      ? const SizedBox.shrink()
      : Notice(
          'mobileWorkspaceTransferPending',
          action: 'mobileWorkspaceTransferCheck',
          onAction: open,
        );
}

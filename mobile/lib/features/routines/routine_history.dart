import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../chat/chat_screen.dart';

class RoutineHistory extends StatefulWidget {
  const RoutineHistory({
    super.key,
    required this.scope,
    required this.routineId,
  });
  final WorkspaceController scope;
  final String routineId;
  @override
  State<RoutineHistory> createState() => _RoutineHistoryState();
}

class _RoutineHistoryState extends State<RoutineHistory> {
  List<Json> runs = [];
  bool busy = false;
  String? error;
  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final response = await widget.scope.request(
        'GET',
        '/routines/${widget.routineId}/runs',
      );
      if (response['routineId'] != widget.routineId) {
        throw const ApiException('INVALID_RESPONSE', 'requestFailed');
      }
      if (mounted) {
        setState(
          () => runs = (response['runs'] as List).whereType<Json>().toList(),
        );
      }
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> open(Json entry) async {
    try {
      final run = await widget.scope.request(
        'GET',
        '/routines/${widget.routineId}/runs/${entry['runId']}',
      );
      await widget.scope.refresh();
      widget.scope.guard();
      final conversation = widget.scope.find(
        'conversations',
        run['conversationId'] as String,
      );
      final messageId = run['resultMessageId'] ?? run['inputMessageId'];
      final message = messageId is String
          ? widget.scope.find('messages', messageId)
          : null;
      final marker = message?['metadata']?['routineRun'];
      if (run['runId'] != entry['runId'] ||
          run['routineId'] != widget.routineId ||
          conversation == null ||
          message == null ||
          message['conversationId'] != conversation['id'] ||
          marker is! Map ||
          marker['runId'] != run['runId'] ||
          marker['routineId'] != run['routineId']) {
        throw const ApiException('RESULT_MISSING', 'runMessageMissing');
      }
      if (mounted) {
        await Navigator.push(
          context,
          MaterialPageRoute<void>(
            builder: (_) => ChatScreen(
              scope: widget.scope,
              conversationId: conversation['id'] as String,
              initialMessageId: messageId as String,
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    }
  }

  String timestamp(Object? value) {
    final at = DateTime.tryParse(value?.toString() ?? '');
    return at == null
        ? ''
        : DateFormat.yMd(
            Localizations.localeOf(context).languageCode,
          ).add_Hm().format(at.toLocal());
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(context.tr('runHistory')),
      actions: [
        IconButton(
          tooltip: context.tr('refresh'),
          onPressed: busy ? null : load,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (error != null) Notice(error!),
        if (busy) const LinearProgressIndicator(),
        if (!busy && runs.isEmpty) Notice('noRunHistory'),
        for (final run in runs)
          Card(
            child: ListTile(
              title: Text(
                '${context.tr('run_${run['status']}')} · ${context.tr('trigger_${run['trigger']}')}',
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(timestamp(run['startedAt'])),
                  if (run['error'] is String) Text(run['error'] as String),
                ],
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => open(run),
            ),
          ),
      ],
    ),
  );
}

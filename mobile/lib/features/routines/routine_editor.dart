import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/routine_access.dart';
import '../../core/routine_operation_controller.dart';
import '../../core/routine_operation_data.dart';
import '../../core/routine_public_search.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'routine_form.dart';
import 'routine_operation_panel.dart';
import 'routine_public_search_fields.dart';

class RoutineEditor extends StatefulWidget {
  const RoutineEditor({
    super.key,
    required this.scope,
    required this.agentId,
    this.routine,
    this.operation,
  });
  final WorkspaceController scope;
  final String agentId;
  final Json? routine;
  final RoutineOperationController? operation;
  @override
  State<RoutineEditor> createState() => _RoutineEditorState();
}

class _RoutineEditorState extends State<RoutineEditor> {
  final form = GlobalKey<FormState>();
  late Json draft;
  late final Json? reviewed;
  late final List<String>? approvedSearch;
  List<String>? searchChange;
  RoutineOperationController? operation;
  bool busy = false, unknown = false;
  String? error;
  @override
  void initState() {
    super.initState();
    final old = widget.routine;
    reviewed = old == null ? null : cloneRoutineData(old);
    approvedSearch = old?.containsKey(routinePublicSearchField) == true
        ? normalizeRoutinePublicQueries(old![routinePublicSearchField])
        : const [];
    if (old == null) {
      operation =
          widget.operation ??
          RoutineOperationController(widget.scope, widget.agentId);
      if (widget.operation == null) unawaited(operation!.initialize());
    }
    final chats = widget.scope.items('conversations').where((chat) {
      final members = chat['agentIds'];
      return chat['isGroup'] == false &&
          members is List &&
          members.length == 1 &&
          members.single == widget.agentId;
    });
    draft = {
      'agentId': widget.agentId,
      'conversationId': old?['conversationId'] ?? chats.firstOrNull?['id'],
      'title': old?['title'] ?? '',
      'prompt': old?['prompt'] ?? '',
      'schedule': old?['schedule'] ?? 'daily:09:00',
      'enabled': old?['enabled'] ?? true,
      'timeZone': old == null
          ? widget.scope.data?['workspaceTimeZone']?['timeZone'] ??
                'Asia/Shanghai'
          : old['timeZone'] ?? 'Asia/Shanghai',
    };
  }

  bool get _localDirectOwner => routineLocalDirectOwner(
    widget.scope,
    widget.agentId,
    draft['conversationId'],
  );

  bool get _webhookAllowed => routineLocalWebhookOwner(
    widget.scope,
    widget.agentId,
    draft['conversationId'],
  );

  @override
  void dispose() {
    if (widget.operation == null) operation?.dispose();
    super.dispose();
  }

  Future<void> save() async {
    final scope = widget.scope;
    if (busy ||
        unknown ||
        !scope.active ||
        !scope.owner ||
        !(form.currentState?.validate() ?? false)) {
      return;
    }
    final nextSearch = searchChange;
    final old = reviewed;
    if (draft['schedule'] == 'webhook' && !_webhookAllowed) {
      setState(() => error = 'routineWebhookTarget');
      return;
    }
    if (nextSearch != null) {
      if (!_localDirectOwner) {
        setState(() => error = 'routinePublicSearchTarget');
        return;
      }
      final current = old == null
          ? null
          : scope.find('routines', old['id'] as String);
      if (old != null &&
          (current == null || !sameRoutineConfig(current, old))) {
        setState(() => error = 'routinePublicSearchChanged');
        return;
      }
    }
    final body = <String, dynamic>{
      ...draft,
      routinePublicSearchField: ?nextSearch,
      if (nextSearch != null && old != null)
        'expectedRoutine': routineConfig(old),
    };
    if (operation != null) {
      await operation!.create(body);
      if (mounted && widget.scope.active) await widget.scope.refresh();
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await scope.request(
        'PATCH',
        '/routines/${old!['id']}',
        body: body,
      );
      if (result['agentId'] != widget.agentId ||
          result['id'] != old['id'] ||
          (nextSearch != null && !_matchesSearch(result, nextSearch))) {
        throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
      }
      await widget.scope.refresh();
      if (mounted && widget.scope.active) Navigator.pop(context, true);
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() {
          error = e is ApiException ? routineConfigError(e) : 'requestFailed';
          unknown = e is! ApiException || e.status == 0 || e.status >= 500;
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  bool _matchesSearch(Json result, List<String> expected) => expected.isEmpty
      ? !result.containsKey(routinePublicSearchField)
      : listEquals(
          normalizeRoutinePublicQueries(result[routinePublicSearchField]),
          expected,
        );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      widget.scope,
      widget.scope.session,
      ?operation,
    ]),
    builder: (context, _) {
      final editable =
          widget.scope.active &&
          widget.scope.owner &&
          !busy &&
          !unknown &&
          !(operation?.locked ?? false);
      return Scaffold(
        appBar: AppBar(
          title: Text(
            context.tr(widget.routine == null ? 'newRoutine' : 'editRoutine'),
          ),
        ),
        body: Form(
          key: form,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (operation != null)
                    RoutineOperationPanel(
                      controller: operation!,
                      onFinished: () => Navigator.pop(context, true),
                    ),
                  if (unknown)
                    Notice(
                      'routineWriteUnknown',
                      action: 'backToRoutines',
                      onAction: () => Navigator.pop(context),
                    ),
                  RoutineForm(
                    initial: draft,
                    enabled: editable,
                    webhookAllowed: _webhookAllowed,
                    onChanged: (value) => draft = value,
                  ),
                  if (_localDirectOwner && approvedSearch != null)
                    RoutinePublicSearchFields(
                      approved: approvedSearch!,
                      editable: editable,
                      onChanged: (value) => searchChange =
                          listEquals(value, approvedSearch) ? null : value,
                    ),
                ],
              ),
            ],
          ),
        ),
        bottomNavigationBar: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (error != null) Notice(error!),
                FilledButton(
                  onPressed: editable && draft['conversationId'] is String
                      ? save
                      : null,
                  child: Text(context.tr('save')),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

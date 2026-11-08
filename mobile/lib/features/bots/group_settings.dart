import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

class GroupSettings extends StatefulWidget {
  const GroupSettings({
    super.key,
    required this.scope,
    required this.conversationId,
  });
  final WorkspaceController scope;
  final String conversationId;
  @override
  State<GroupSettings> createState() => _GroupSettingsState();
}

class _GroupSettingsState extends State<GroupSettings> {
  final form = GlobalKey<FormState>();
  final title = TextEditingController();
  final goal = TextEditingController();
  final summary = TextEditingController();
  final assignments = <String, TextEditingController>{};
  Json? saved;
  final List<String> members = [];
  final Set<String> original = {};
  bool planned = false;
  bool busy = false;
  bool unknown = false;
  String? error;
  @override
  void initState() {
    super.initState();
    unawaited(_read());
  }

  @override
  void dispose() {
    for (final c in [title, goal, summary, ...assignments.values]) {
      c.dispose();
    }
    super.dispose();
  }

  String get path => '/conversations/${widget.conversationId}/settings';
  Future<void> _read() async {
    try {
      final value = await widget.scope.request('GET', path);
      if (!mounted) return;
      final chat = value['conversation'];
      if (chat is! Json || chat['isGroup'] != true) {
        throw const ApiException('INVALID_RESPONSE', 'unavailable');
      }
      setState(() {
        saved = value;
        title.text = chat['title'] as String? ?? '';
        members
          ..clear()
          ..addAll((chat['agentIds'] as List).cast<String>());
        original
          ..clear()
          ..addAll(members);
        planned = chat['teamBrief'] is Json;
        goal.text = chat['teamBrief']?['goal'] as String? ?? '';
        summary.text = chat['teamBrief']?['summary'] as String? ?? '';
        for (final c in assignments.values) {
          c.dispose();
        }
        assignments.clear();
        for (final item
            in (chat['teamBrief']?['assignments'] as List? ?? [])
                .whereType<Json>()) {
          assignments[item['agentId'] as String] = TextEditingController(
            text: item['assignment'] as String? ?? '',
          );
        }
        for (final id in members) {
          assignments.putIfAbsent(id, () => TextEditingController());
        }
        unknown = false;
        error = null;
      });
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    }
  }

  Future<void> _save() async {
    if (busy ||
        saved == null ||
        unknown ||
        members.isEmpty ||
        !form.currentState!.validate()) {
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    final body = {
      'expectedRevision': saved!['revision'],
      'title': title.text.trim(),
      'agentIds': members.toList(),
      if (planned)
        'teamBrief': {
          'goal': goal.text.trim(),
          'summary': summary.text.trim(),
          'leadAgentId': members.first,
          'assignments': members
              .map(
                (id) => {
                  'agentId': id,
                  'assignment': assignments[id]!.text.trim(),
                },
              )
              .toList(),
        },
    };
    try {
      await widget.scope.request('PATCH', path, body: body);
      await widget.scope.refresh();
      if (mounted && widget.scope.active) Navigator.pop(context);
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() {
          error = e is ApiException ? e.message : 'requestFailed';
          unknown = e is! ApiException || e.status == 0 || e.status >= 500;
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget _field(
    TextEditingController input,
    String label,
    int max, {
    int lines = 1,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: TextFormField(
      controller: input,
      enabled: saved != null && !busy && !unknown,
      maxLength: max,
      minLines: lines,
      maxLines: lines == 1 ? 1 : 8,
      decoration: InputDecoration(labelText: context.tr(label)),
      validator: (value) =>
          (value ?? '').trim().isEmpty ? context.tr('required') : null,
    ),
  );
  @override
  Widget build(BuildContext context) {
    final editable = saved != null && !busy && !unknown;
    final bots = widget.scope.items('agents');
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('groupSettings'))),
      body: Form(
        key: form,
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (error != null)
              Notice(
                error!,
                action: 'refresh',
                onAction: busy
                    ? null
                    : () async {
                        if (await confirm(context, 'loadCurrent')) {
                          await _read();
                        }
                      },
              ),
            if (unknown) const Notice('requestUnknown'),
            _field(title, 'groupName', 100),
            if (members.isNotEmpty)
              DropdownButtonFormField<String>(
                key: ValueKey(members.first),
                initialValue: members.first,
                decoration: InputDecoration(labelText: context.tr('lead')),
                items: members
                    .map(
                      (id) => DropdownMenuItem(
                        value: id,
                        child: Text(
                          widget.scope.find('agents', id)?['name'] as String? ??
                              id,
                        ),
                      ),
                    )
                    .toList(),
                onChanged: editable
                    ? (id) {
                        if (id != null) {
                          setState(() {
                            members.remove(id);
                            members.insert(0, id);
                          });
                        }
                      }
                    : null,
              ),
            const SizedBox(height: 16),
            for (final bot in bots)
              CheckboxListTile(
                value: members.contains(bot['id']),
                title: Text(bot['name'] as String? ?? ''),
                subtitle: Text(bot['role'] as String? ?? ''),
                onChanged:
                    editable &&
                        (members.contains(bot['id']) ||
                            (original.length <= 6 &&
                                members.length < 6 &&
                                botAvailable(bot)))
                    ? (yes) {
                        setState(() {
                          final id = bot['id'] as String;
                          if (yes == true) {
                            members.add(id);
                            assignments.putIfAbsent(
                              id,
                              () => TextEditingController(),
                            );
                          } else if (members.length > 1) {
                            members.remove(id);
                          }
                        });
                      }
                    : null,
              ),
            if (planned) ...[
              const SizedBox(height: 20),
              _field(goal, 'goal', 6000, lines: 3),
              _field(summary, 'summary', 2000, lines: 3),
              for (final id in members) ...[
                Text(
                  widget.scope.find('agents', id)?['name'] as String? ?? id,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 8),
                _field(assignments[id]!, 'assignment', 2000, lines: 2),
              ],
            ],
            const SizedBox(height: 20),
            FilledButton(
              onPressed: editable && members.isNotEmpty ? _save : null,
              child: Text(context.tr('save')),
            ),
          ],
        ),
      ),
    );
  }
}

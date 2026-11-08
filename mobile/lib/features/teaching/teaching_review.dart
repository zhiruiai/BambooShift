import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'teaching_controller.dart';

class TeachingReview extends StatelessWidget {
  const TeachingReview({super.key, required this.controller});
  final TeachingController controller;
  @override
  Widget build(BuildContext context) {
    final c = controller, record = c.record!, draft = c.draft!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (c.changed) ...[
          const Notice('mobileTeachingChanged'),
          TextButton(
            onPressed: c.busy ? null : c.loadDraft,
            child: Text(context.tr('mobileTeachingLoadCurrent')),
          ),
        ],
        TextFormField(
          key: ValueKey('goal-${c.editorVersion}'),
          initialValue: draft['goal'],
          enabled: c.editable,
          maxLength: 2000,
          minLines: 2,
          maxLines: 5,
          decoration: InputDecoration(
            labelText: context.tr('mobileTeachingGoal'),
          ),
          onChanged: c.updateGoal,
        ),
        for (final step in draft['steps'] as List)
          Builder(
            builder: (context) {
              final original = (record['steps'] as List)
                  .where((s) => s['id'] == step['id'])
                  .firstOrNull;
              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        context.tr(
                          'mobileTeachingAction_${original?['action'] ?? 'key'}',
                        ),
                      ),
                      if (original?['details'] is Map &&
                          (original['details'] as Map).isNotEmpty)
                        SelectableText(
                          (original['details'] as Map).entries
                              .map((e) => '${e.key}: ${e.value}')
                              .join(' · '),
                        ),
                      TextFormField(
                        key: ValueKey('note-${step['id']}-${c.editorVersion}'),
                        initialValue: step['note'],
                        enabled: c.editable,
                        maxLength: 1000,
                        maxLines: 3,
                        decoration: InputDecoration(
                          labelText: context.tr('mobileTeachingNote'),
                        ),
                        onChanged: (text) => c.updateNote(step['id'], text),
                      ),
                      TextButton(
                        onPressed: c.editable
                            ? () => c.removeStep(step['id'])
                            : null,
                        child: Text(context.tr('mobileTeachingRemove')),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        if ((draft['steps'] as List).isEmpty)
          const Notice('mobileTeachingEmpty'),
        OutlinedButton(
          onPressed: c.editable && c.dirty && !c.changed ? c.save : null,
          child: Text(context.tr('mobileTeachingSave')),
        ),
        if (c.dirty) const Notice('mobileTeachingDirty'),
        DropdownButtonFormField<String>(
          key: ValueKey('model-${c.selectedModel}'),
          initialValue: c.selectedModel,
          isExpanded: true,
          decoration: InputDecoration(
            labelText: context.tr('mobileTeachingModel'),
          ),
          items: [
            for (final m in c.models)
              DropdownMenuItem(
                value: m['id'] as String,
                child: Text(
                  m['name'] as String,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: c.editable ? c.chooseModel : null,
        ),
        if (c.models.isEmpty) const Notice('mobileTeachingNoModels'),
        if (record['interrupted'] == true)
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(context.tr('mobileTeachingPartial')),
            value: c.acceptPartial,
            onChanged: c.editable
                ? (v) {
                    c.acceptPartial = v == true;
                    c.notify();
                  }
                : null,
          ),
        FilledButton(
          onPressed:
              c.editable &&
                  !c.dirty &&
                  !c.changed &&
                  c.selectedModel != null &&
                  (draft['goal'] as String).trim().isNotEmpty &&
                  (draft['steps'] as List).isNotEmpty &&
                  (record['interrupted'] != true || c.acceptPartial)
              ? () async {
                  final id = c.record?['id'], revision = c.record?['revision'];
                  final model = c.selectedModel, snapshot = c.modelSnapshot;
                  final partial = c.acceptPartial;
                  if (await confirm(context, 'mobileTeachingGenerateConfirm') &&
                      context.mounted) {
                    if (c.record?['id'] != id ||
                        c.record?['revision'] != revision ||
                        c.selectedModel != model ||
                        c.modelSnapshot != snapshot ||
                        c.acceptPartial != partial ||
                        c.dirty ||
                        c.changed) {
                      c.error = 'mobileTeachingChanged';
                      c.notify();
                      return;
                    }
                    await c.generate();
                  }
                }
              : null,
          child: Text(context.tr('mobileTeachingGenerate')),
        ),
      ],
    );
  }
}

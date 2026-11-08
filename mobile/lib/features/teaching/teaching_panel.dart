import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../bots/knowledge_screen.dart';
import 'teaching_controller.dart';
import 'teaching_review.dart';

class TeachingPanel extends StatelessWidget {
  const TeachingPanel({super.key, required this.controller});
  final TeachingController controller;

  Future<void> start(BuildContext context) async {
    final computer = controller.computer;
    final lease = computer.lease, binding = computer.status?.fingerprint;
    final revision = controller.scope.find(
      'agents',
      computer.agentId,
    )?['configRevision'];
    if (await confirm(context, 'mobileTeachingStartConfirm') &&
        context.mounted &&
        controller.active) {
      if (computer.lease != lease ||
          computer.status?.fingerprint != binding ||
          controller.scope.find(
                'agents',
                computer.agentId,
              )?['configRevision'] !=
              revision) {
        controller.error = 'mobileTeachingBindingChanged';
        controller.notify();
        return;
      }
      await controller.start();
    }
  }

  Future<void> cancel(BuildContext context) async {
    final operation = controller.pending?['operationId'];
    if (await confirm(context, 'mobileTeachingCancelConfirm') &&
        context.mounted &&
        controller.active) {
      if (controller.pending?['operationId'] != operation) {
        controller.error = 'mobileTeachingPendingChanged';
        controller.notify();
        return;
      }
      await controller.cancel();
    }
  }

  Future<void> skill(BuildContext context) async {
    final c = controller, record = c.record;
    if (!c.active || record?['status'] != 'proposed') {
      return;
    }
    await c.scope.refresh();
    if (!context.mounted || !c.active) {
      return;
    }
    final skill = c.scope.find('skills', record!['skillId']);
    if (skill == null ||
        skill['agentId'] != c.computer.agentId ||
        skill['teachingSessionId'] != record['id']) {
      c.error = 'mobileTeachingSkillMissing';
      c.notify();
      return;
    }
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => KnowledgeScreen(
          scope: c.scope,
          agentId: c.computer.agentId,
          kind: 'skills',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      controller,
      controller.computer,
      controller.scope.session,
    ]),
    builder: (context, _) {
      final c = controller, record = c.record;
      if (!c.scope.owner) {
        return const Notice('mobileTeachingOwner');
      }
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                context.tr('mobileTeachingTitle'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const Notice('mobileTeachingPrivacy'),
              const Notice('mobileTeachingLimits'),
              if (!c.local) const Notice('mobileTeachingLocal'),
              if (c.busy) const LinearProgressIndicator(),
              if (c.error != null) Notice(c.error!),
              if (c.uncertain) ...[
                const Notice('mobileTeachingUnknown'),
                TextButton(
                  onPressed: c.busy ? null : () => cancel(context),
                  child: Text(context.tr('mobileTeachingCancel')),
                ),
              ],
              if (record == null && c.pending == null)
                FilledButton(
                  onPressed: c.canStart ? () => start(context) : null,
                  child: Text(context.tr('mobileTeachingStart')),
                ),
              if (record != null) ...[
                Text(context.tr('mobileTeachingStatus_${record['status']}')),
                Text(
                  '${context.tr('mobileTeachingSteps')}: ${(record['steps'] as List).length}',
                ),
                if (record['status'] == 'recording') ...[
                  const Notice('mobileTeachingRecordingHint'),
                  if (!c.liveRecording)
                    const Notice('mobileTeachingRecoveredRecording'),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 180),
                    child: SingleChildScrollView(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          for (final step in record['steps'] as List)
                            Text(
                              context.tr(
                                'mobileTeachingAction_${step['action']}',
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                  FilledButton(
                    onPressed: c.busy || c.computer.busy || c.uncertain
                        ? null
                        : c.stop,
                    child: Text(context.tr('mobileTeachingStop')),
                  ),
                ],
                if ([
                      'review',
                      'interrupted',
                      'error',
                    ].contains(record['status']) &&
                    c.draft != null)
                  TeachingReview(controller: c),
                if (record['status'] == 'generating') ...[
                  const Notice('mobileTeachingGeneratingHint'),
                  TextButton(
                    onPressed: c.busy ? null : () => cancel(context),
                    child: Text(context.tr('mobileTeachingCancel')),
                  ),
                ],
                if (record['status'] == 'proposed') ...[
                  const Notice('mobileTeachingProposedHint'),
                  FilledButton(
                    onPressed: c.busy ? null : () => skill(context),
                    child: Text(context.tr('mobileTeachingOpenSkill')),
                  ),
                ],
                if (!['recording', 'generating'].contains(record['status']))
                  TextButton(
                    onPressed: c.busy || c.uncertain ? null : c.newRecording,
                    child: Text(context.tr('mobileTeachingNew')),
                  ),
              ],
              if (c.history.isNotEmpty)
                ExpansionTile(
                  title: Text(context.tr('mobileTeachingHistory')),
                  children: [
                    for (final item in c.history)
                      ListTile(
                        title: Text(
                          context.tr('mobileTeachingStatus_${item['status']}'),
                        ),
                        subtitle: Text(item['createdAt'] as String),
                        onTap:
                            c.busy ||
                                c.uncertain ||
                                [
                                  'recording',
                                  'generating',
                                ].contains(record?['status'])
                            ? null
                            : () => c.select(item),
                      ),
                  ],
                ),
              TextButton(
                onPressed: c.busy || !c.active ? null : c.check,
                child: Text(context.tr('mobileTeachingRefresh')),
              ),
            ],
          ),
        ),
      );
    },
  );
}

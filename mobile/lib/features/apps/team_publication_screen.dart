import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../bots/team_skill_link.dart';
import 'private_skill_data.dart';
import 'team_publication_controller.dart';
import 'team_publication_data.dart';

class TeamPublicationScreen extends StatefulWidget {
  const TeamPublicationScreen({
    super.key,
    required this.controller,
    this.skill,
  });

  final TeamPublicationController controller;
  final PrivateSkill? skill;

  @override
  State<TeamPublicationScreen> createState() => _TeamPublicationScreenState();
}

class _TeamPublicationScreenState extends State<TeamPublicationScreen> {
  TeamPublicationController get controller => widget.controller;
  String? _selectedId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(controller.refresh(widget.skill));
    });
  }

  Future<void> _cancel(TeamPublicationRequest request) async {
    if (!await confirm(context, 'mobileTeamPublishCancelHelp') || !mounted) {
      return;
    }
    await controller.recover(request, skill: widget.skill, cancel: true);
  }

  Future<void> _removeReminder(TeamPublicationRequest request) async {
    if (await confirm(context, 'mobileTeamPublishReminderHelp') && mounted) {
      await controller.removeReminder(request, skill: widget.skill);
    }
  }

  Widget _pending(TeamPublicationRequest request) => Card(
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(request.teamName, style: Theme.of(context).textTheme.titleSmall),
          Text(context.tr('mobileTeamPublishUnknown')),
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: controller.busy
                    ? null
                    : () => controller.recover(request, skill: widget.skill),
                child: Text(context.tr('mobileTeamPublishCheck')),
              ),
              TextButton(
                onPressed: controller.busy ? null : () => _cancel(request),
                child: Text(context.tr('mobileTeamPublishCancel')),
              ),
              if (controller.canRemoveReminder(request))
                TextButton(
                  onPressed: controller.busy
                      ? null
                      : () => _removeReminder(request),
                  child: Text(context.tr('mobileTeamPublishReminderRemove')),
                ),
            ],
          ),
        ],
      ),
    ),
  );

  Widget? _copyLink(String teamId, TeamPublication publication) {
    if (controller.pending.any((request) => request.teamId == teamId)) {
      return null;
    }
    return TeamSkillLinkButton(
      scope: controller.scope,
      teamId: teamId,
      publicationId: publication.id,
      linkId: publication.linkId,
      enabled: !controller.busy,
    );
  }

  Widget _review(
    PrivateSkill skill,
    TeamPublicationTarget? selected,
    Widget? link,
  ) {
    final targets = controller.targets;
    final previous = selected?.publication;
    final current = previous?.sourceRevision == skill.revision;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(skill.name, style: Theme.of(context).textTheme.titleLarge),
        Text(
          context
              .tr('mobileTeamPublishSourceVersion')
              .replaceAll('{version}', '${skill.version}'),
        ),
        const SizedBox(height: 12),
        Text(context.tr('mobileTeamPublishHelp')),
        const SizedBox(height: 12),
        if (targets.isNotEmpty)
          DropdownButtonFormField<String>(
            key: ValueKey(selected?.id),
            initialValue: selected?.id,
            isExpanded: true,
            decoration: InputDecoration(
              labelText: context.tr('mobileTeamPublishChoose'),
            ),
            items: [
              for (final target in targets)
                DropdownMenuItem(
                  value: target.id,
                  child: Text(target.name, overflow: TextOverflow.ellipsis),
                ),
            ],
            onChanged: controller.busy
                ? null
                : (value) => setState(() => _selectedId = value),
          )
        else if (!controller.busy && controller.feedback == null)
          const Notice('mobileTeamPublishNoTeams'),
        if (selected != null) ...[
          const SizedBox(height: 8),
          Text(
            previous == null
                ? context.tr('mobileTeamPublishFirst')
                : context
                      .tr(
                        current
                            ? 'mobileTeamPublishCurrent'
                            : 'mobileTeamPublishPrior',
                      )
                      .replaceAll('{version}', '${previous.version}'),
          ),
        ],
        if (link != null)
          Align(alignment: AlignmentDirectional.centerStart, child: link),
        const SizedBox(height: 16),
        Text(skill.description),
        const SizedBox(height: 8),
        Text(
          context.tr('mobileAppsPrivateSkillContent'),
          style: Theme.of(context).textTheme.titleSmall,
        ),
        const SizedBox(height: 6),
        SelectableText(skill.content),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final skill = widget.skill;
      final selected = controller.targets
          .where((team) => team.id == _selectedId)
          .firstOrNull;
      final receipt = controller.confirmed;
      final link = switch ((selected, receipt)) {
        (final team?, _) when team.publication != null => _copyLink(
          team.id,
          team.publication!,
        ),
        (_, final confirmed?)
            when skill == null ||
                (!controller.hasTargetsFor(skill) &&
                    confirmed.teamId == _selectedId) =>
          _copyLink(confirmed.teamId, confirmed.publication),
        _ => null,
      };
      final canPublish =
          skill != null && controller.canPublish(skill, selected);
      return PopScope(
        canPop: !controller.active || !controller.busy,
        child: Scaffold(
          appBar: AppBar(
            title: Text(
              context.tr(
                skill == null
                    ? 'mobileTeamPublishCheck'
                    : 'mobileTeamSkillPublish',
              ),
            ),
            actions: [
              IconButton(
                tooltip: context.tr('refresh'),
                onPressed: !controller.active || controller.busy
                    ? null
                    : () => controller.refresh(skill),
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          body: !controller.active
              ? const Notice('scopeChanged')
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (controller.busy) const LinearProgressIndicator(),
                    if (controller.feedback case final feedback?)
                      Notice(feedback),
                    for (final request in controller.pending) _pending(request),
                    if (skill != null) _review(skill, selected, link),
                    if (skill == null && link != null)
                      Align(
                        alignment: AlignmentDirectional.centerStart,
                        child: link,
                      ),
                    if (skill == null &&
                        controller.pending.isEmpty &&
                        controller.feedback == null &&
                        !controller.busy)
                      const Notice('mobileTeamPublishNoPending'),
                  ],
                ),
          bottomNavigationBar: skill == null || !controller.active
              ? null
              : SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                    child: FilledButton(
                      onPressed: canPublish
                          ? () => controller.publish(skill, selected!)
                          : null,
                      child: Text(
                        context.tr(
                          selected?.publication == null
                              ? 'mobileTeamPublishConfirm'
                              : 'mobileTeamPublishSync',
                        ),
                      ),
                    ),
                  ),
                ),
        ),
      );
    },
  );
}

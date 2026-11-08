import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'private_skill_controller.dart';
import 'private_skill_data.dart';
import 'team_publication_controller.dart';
import 'team_publication_screen.dart';

class PrivateSkillsScreen extends StatefulWidget {
  const PrivateSkillsScreen({super.key, required this.scope});
  final WorkspaceController scope;

  @override
  State<PrivateSkillsScreen> createState() => _PrivateSkillsScreenState();
}

class _PrivateSkillsScreenState extends State<PrivateSkillsScreen> {
  late final PrivateSkillController _controller;
  late final TeamPublicationController _team;
  PrivateSkillKey? _selection;
  String? _target;

  @override
  void initState() {
    super.initState();
    _controller = PrivateSkillController(widget.scope);
    _team = TeamPublicationController(widget.scope);
    unawaited(_controller.refresh());
    unawaited(_team.refresh());
  }

  @override
  void dispose() {
    _controller.dispose();
    _team.dispose();
    super.dispose();
  }

  void _select(PrivateSkill? skill, [String? target]) {
    setState(() {
      _selection = skill?.key;
      _target = target;
    });
  }

  void _publication([PrivateSkill? skill]) {
    Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => TeamPublicationScreen(controller: _team, skill: skill),
      ),
    );
  }

  String _origin(BuildContext context, PrivateSkill skill) => context
      .tr('mobileAppsPrivateSkillOrigin')
      .replaceAll('{version}', '${skill.version}')
      .replaceAll('{bot}', skill.sourceAgentName);

  String _status(PrivateSkill skill) => skill.available
      ? 'mobileAppsPrivateSkillOriginal'
      : 'mobileAppsPrivateSkillPrevious';

  Future<void> _change(
    PrivateSkill skill,
    PrivateSkillBot target,
    bool enabled,
  ) async {
    final label = enabled
        ? 'mobileAppsPrivateSkillEnable'
        : 'mobileAppsPrivateSkillDisable';
    if (!_controller.canChange(skill, target.id, enabled)) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => ListenableBuilder(
        listenable: _controller,
        builder: (context, _) {
          final allowed = _controller.canChange(skill, target.id, enabled);
          return AlertDialog(
            scrollable: true,
            title: Text(context.tr(label)),
            content: allowed
                ? Text(
                    '${skill.name}\n${_origin(context, skill)}\n${context.tr('mobileAppsPrivateSkillTarget')} · ${target.name}\n\n${context.tr(enabled ? 'mobileAppsPrivateSkillConfirmEnable' : 'mobileAppsPrivateSkillConfirmDisable')}',
                  )
                : Text(context.tr('mobileAppsPrivateSkillChanged')),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: Text(context.tr('cancel')),
              ),
              FilledButton(
                onPressed: allowed ? () => Navigator.pop(context, true) : null,
                child: Text(context.tr('done')),
              ),
            ],
          );
        },
      ),
    );
    if (confirmed == true &&
        mounted &&
        _selection == skill.key &&
        _target == target.id) {
      await _controller.change(skill, target.id, enabled);
    }
  }

  Widget _targetControls(BuildContext context, PrivateSkill skill) {
    final shelf = _controller.shelf;
    final targets = shelf.targets(skill);
    final target = targets.where((bot) => bot.id == _target).firstOrNull;
    final enabled = skill.enabledAgentIds.contains(target?.id);
    final earlier = skill.available && target != null && !enabled
        ? shelf.earlier(skill, target.id)
        : null;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: targets.isEmpty
              ? [Text(context.tr('mobileAppsPrivateSkillNoTarget'))]
              : [
                  DropdownButtonFormField<String>(
                    key: ValueKey((skill.key, target?.id)),
                    initialValue: target?.id,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: context.tr('mobileAppsPrivateSkillTarget'),
                    ),
                    hint: Text(context.tr('mobileAppsPrivateSkillChooseBot')),
                    items: [
                      for (final bot in targets)
                        DropdownMenuItem(
                          value: bot.id,
                          child: Text(
                            bot.name,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: !_controller.busy
                        ? (value) => setState(() => _target = value)
                        : null,
                  ),
                  const SizedBox(height: 6),
                  if (earlier != null && target != null) ...[
                    Text(context.tr('mobileAppsPrivateSkillEarlierPinned')),
                    OutlinedButton(
                      onPressed: !_controller.busy
                          ? () => _select(earlier, target.id)
                          : null,
                      child: Text(
                        context.tr('mobileAppsPrivateSkillReviewInstalled'),
                      ),
                    ),
                  ] else
                    FilledButton(
                      onPressed:
                          target != null &&
                              _controller.canChange(skill, target.id, !enabled)
                          ? () => _change(skill, target, !enabled)
                          : null,
                      child: Text(
                        context.tr(
                          enabled
                              ? 'mobileAppsPrivateSkillDisable'
                              : 'mobileAppsPrivateSkillEnable',
                        ),
                      ),
                    ),
                ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([_controller, _team]),
    builder: (context, _) {
      final shelf = _controller.shelf;
      final skill = shelf.find(_selection);
      return PopScope(
        canPop: skill == null,
        onPopInvokedWithResult: (popped, _) {
          if (!popped && _selection != null && !_controller.busy) _select(null);
        },
        child: Scaffold(
          appBar: AppBar(
            title: Text(
              skill?.name ?? context.tr('mobileAppsPrivateSkillsTitle'),
            ),
            actions: [
              IconButton(
                tooltip: context.tr('mobileAppsPrivateSkillsRefresh'),
                onPressed: _controller.active && !_controller.busy
                    ? _controller.refresh
                    : null,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          bottomNavigationBar: _controller.active && skill != null
              ? _targetControls(context, skill)
              : null,
          body: !_controller.active
              ? const Notice('scopeChanged')
              : ListView(
                  key: ValueKey(_selection),
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (_controller.busy) const LinearProgressIndicator(),
                    if (_controller.feedback case final feedback?)
                      Notice(feedback),
                    if (_team.pending.isNotEmpty)
                      TextButton.icon(
                        onPressed: _team.busy ? null : () => _publication(),
                        icon: const Icon(Icons.history),
                        label: Text(context.tr('mobileTeamPublishCheck')),
                      ),
                    if (skill != null) ...[
                      Text(
                        '${_origin(context, skill)} · ${context.tr(_status(skill))}',
                      ),
                      if (skill.description.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Text(skill.description),
                        ),
                      if (skill.available &&
                          skill.description.trim().isNotEmpty)
                        OutlinedButton.icon(
                          onPressed: _team.busy || !_controller.authoritative
                              ? null
                              : () => _publication(skill),
                          icon: const Icon(Icons.group_outlined),
                          label: Text(context.tr('mobileTeamSkillPublish')),
                        ),
                      Text(
                        context.tr('mobileAppsPrivateSkillRevision'),
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      SelectableText(skill.revision),
                      const SizedBox(height: 12),
                      Text(
                        context.tr('mobileAppsPrivateSkillContent'),
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 6),
                      SelectableText(skill.content),
                    ] else ...[
                      Text(context.tr('mobileAppsPrivateSkillsHelp')),
                      if (_selection != null &&
                          _controller.authoritative &&
                          _controller.feedback == null)
                        const Notice('mobileAppsPrivateSkillChanged'),
                      if (shelf.skills.isEmpty &&
                          _controller.authoritative &&
                          _controller.feedback == null)
                        const Notice('mobileAppsPrivateSkillsEmpty'),
                      for (final row in shelf.skills)
                        Card(
                          child: ListTile(
                            leading: const Icon(Icons.menu_book_outlined),
                            title: Text(row.name),
                            subtitle: Text(
                              '${_origin(context, row)}\n${context.tr(_status(row))}',
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: !_controller.busy
                                ? () => _select(row)
                                : null,
                          ),
                        ),
                    ],
                  ],
                ),
        ),
      );
    },
  );
}

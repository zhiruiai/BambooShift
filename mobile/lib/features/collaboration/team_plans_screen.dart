import 'dart:async';
import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../chat/chat_screen.dart';
import '../settings/model_settings.dart';
import 'team_controller.dart';
import 'team_editor.dart';
import 'team_plan_status.dart';
import 'team_starter_picker.dart';

class TeamPlansScreen extends StatefulWidget {
  const TeamPlansScreen({
    super.key,
    required this.scope,
    this.initialPlanId,
    this.openTeamTemplates = false,
  }) : assert(initialPlanId == null || !openTeamTemplates);
  final WorkspaceController scope;
  final String? initialPlanId;
  final bool openTeamTemplates;
  @override
  State<TeamPlansScreen> createState() => _TeamPlansScreenState();
}

class _TeamPlansScreenState extends State<TeamPlansScreen>
    with WidgetsBindingObserver {
  late final TeamController controller;
  Timer? timer;
  bool foreground = true, leaving = false, navigating = false;
  late bool _autoOpenStarter = widget.openTeamTemplates;
  bool _starterQueued = false, _starterOpen = false;

  bool get _starterReady =>
      controller.active &&
      controller.ready &&
      !controller.busy &&
      !controller.blocked &&
      controller.pending == null &&
      controller.plan == null;
  @override
  void initState() {
    super.initState();
    controller = TeamController(widget.scope)..addListener(schedule);
    WidgetsBinding.instance.addObserver(this);
    unawaited(controller.initialize(widget.initialPlanId));
  }

  void schedule() {
    _scheduleStarter();
    timer?.cancel();
    if (foreground &&
        controller.active &&
        !controller.busy &&
        controller.pending == null &&
        controller.plan?['status'] == 'generating') {
      timer = Timer(
        const Duration(seconds: 5),
        () => unawaited(controller.check()),
      );
    }
  }

  void _scheduleStarter() {
    if (!_autoOpenStarter || !mounted || _starterQueued) return;
    if (controller.pending != null ||
        controller.plan != null ||
        controller.blocked) {
      _autoOpenStarter = false;
      return;
    }
    if (!foreground || !_starterReady) return;
    _starterQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _starterQueued = false;
      if (mounted && _autoOpenStarter) unawaited(_browseStarter());
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _browseStarter() async {
    if (!_starterReady ||
        _starterOpen ||
        !foreground ||
        ModalRoute.of(context)?.isCurrent != true) {
      return;
    }
    _autoOpenStarter = false;
    _starterOpen = true;
    final language = controller.starterLanguage;
    try {
      final starter = await pickTeamStarter(context, controller, language);
      if (mounted &&
          starter != null &&
          _starterReady &&
          foreground &&
          controller.starterLanguage == language &&
          ModalRoute.of(context)?.isCurrent == true) {
        await controller.start(template: starter, templateLanguage: language);
      }
    } finally {
      _starterOpen = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = state == AppLifecycleState.resumed;
    schedule();
  }

  @override
  void dispose() {
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    controller.removeListener(schedule);
    controller.dispose();
    super.dispose();
  }

  Future<bool> leaveDraft() async {
    if (controller.busy || navigating) return false;
    if (!controller.dirty &&
        controller.pending == null &&
        (controller.plan != null || controller.goal.trim().isEmpty)) {
      return true;
    }
    return confirm(
      context,
      controller.pending == null
          ? 'mobileCollaborationLeaveDraft'
          : 'mobileCollaborationLeavePending',
    );
  }

  Future<void> leave() async {
    if (leaving || !await leaveDraft() || !mounted) return;
    setState(() => leaving = true);
    Navigator.pop(context);
  }

  Future<void> selectPlan(Json? value) async {
    if (controller.pending != null ||
        !await leaveDraft() ||
        !mounted ||
        !controller.active) {
      return;
    }
    if (value == null) {
      controller.newPlan();
    } else {
      await controller.load(value['id']);
    }
  }

  Future<void> createTeam() async {
    if (!controller.editable ||
        !await confirm(context, 'mobileCollaborationCommitConfirm') ||
        !mounted) {
      return;
    }
    if (controller.editable) await controller.save(commit: true);
  }

  Future<void> openConversation(bool start) async {
    if (navigating || controller.busy) return;
    if (start && !await confirm(context, 'mobileCollaborationStartConfirm')) {
      return;
    }
    if (!mounted || !controller.active) return;
    setState(() => navigating = true);
    final id = await controller.conversation(start: start);
    if (mounted && controller.active && id != null) {
      unawaited(widget.scope.refresh());
      await Navigator.push(
        context,
        MaterialPageRoute<void>(
          builder: (_) => ChatScreen(scope: widget.scope, conversationId: id),
        ),
      );
    }
    if (mounted) setState(() => navigating = false);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([controller, widget.scope]),
    builder: (context, _) {
      final plan = controller.plan;
      final configured = widget.scope.data?['settings']?['configured'] == true;
      final model = widget.scope.data?['settings']?['profileName'];
      return PopScope(
        canPop: leaving,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) unawaited(leave());
        },
        child: Scaffold(
          appBar: AppBar(title: Text(context.tr('mobileCollaborationTitle'))),
          body: !controller.active
              ? const Notice('mobileCollaborationOwner')
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Text(context.tr('mobileCollaborationIntro')),
                    if (controller.busy || navigating)
                      const LinearProgressIndicator(),
                    if (controller.error != null) Notice(controller.error!),
                    if (controller.notice != null) Notice(controller.notice!),
                    if (controller.blocked)
                      const Notice('mobileCollaborationStorage'),
                    TeamPlanStatus(controller: controller),
                    if (plan == null && controller.pending == null) ...[
                      OutlinedButton.icon(
                        icon: const Icon(Icons.groups_outlined),
                        label: Text(context.tr('mobileTeamStarterTitle')),
                        onPressed: _starterReady ? _browseStarter : null,
                      ),
                      if (!configured)
                        Notice(
                          'modelMissing',
                          action: 'model',
                          onAction: controller.busy
                              ? null
                              : () async {
                                  await Navigator.push(
                                    context,
                                    MaterialPageRoute<void>(
                                      builder: (_) =>
                                          ModelSettings(scope: widget.scope),
                                    ),
                                  );
                                  if (mounted && controller.active) {
                                    unawaited(widget.scope.refresh());
                                  }
                                },
                        ),
                      if (configured && model is String)
                        Text('${context.tr('model')} · $model'),
                      TextFormField(
                        key: ValueKey('goal-${controller.editorVersion}'),
                        initialValue: controller.goal,
                        enabled:
                            controller.ready &&
                            !controller.busy &&
                            !controller.blocked,
                        minLines: 3,
                        maxLines: 8,
                        maxLength: 6000,
                        decoration: InputDecoration(
                          labelText: context.tr('mobileCollaborationGoal'),
                        ),
                        onChanged: controller.changeGoal,
                      ),
                      FilledButton(
                        onPressed:
                            configured &&
                                controller.ready &&
                                !controller.busy &&
                                !controller.blocked &&
                                controller.goal.trim().isNotEmpty
                            ? controller.start
                            : null,
                        child: Text(context.tr('mobileCollaborationGenerate')),
                      ),
                    ],
                    if (plan != null) ...[
                      Text(
                        context.tr(
                          'mobileCollaborationState_${plan['status']}',
                        ),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      SelectableText(plan['goal'] as String),
                      if (plan['status'] == 'error')
                        const Notice('mobileCollaborationGenerationFailed'),
                      if (plan['status'] == 'ready' &&
                          controller.draft != null) ...[
                        TeamEditor(
                          key: ValueKey(
                            '${plan['id']}:${controller.editorVersion}',
                          ),
                          controller: controller,
                        ),
                        Wrap(
                          spacing: 8,
                          children: [
                            OutlinedButton(
                              onPressed: controller.editable
                                  ? () => controller.save()
                                  : null,
                              child: Text(
                                context.tr('mobileCollaborationSave'),
                              ),
                            ),
                            FilledButton(
                              onPressed: controller.editable
                                  ? createTeam
                                  : null,
                              child: Text(
                                context.tr('mobileCollaborationCommit'),
                              ),
                            ),
                          ],
                        ),
                      ],
                      if (plan['status'] == 'committed')
                        Wrap(
                          spacing: 8,
                          children: [
                            OutlinedButton(
                              onPressed:
                                  !controller.busy &&
                                      !navigating &&
                                      controller.pending == null
                                  ? () => openConversation(false)
                                  : null,
                              child: Text(
                                context.tr('mobileCollaborationOpen'),
                              ),
                            ),
                            FilledButton(
                              onPressed:
                                  !controller.busy &&
                                      !navigating &&
                                      controller.pending == null
                                  ? () => openConversation(true)
                                  : null,
                              child: Text(
                                context.tr('mobileCollaborationStart'),
                              ),
                            ),
                          ],
                        ),
                      Wrap(
                        spacing: 8,
                        children: [
                          TextButton(
                            onPressed: controller.busy
                                ? null
                                : controller.check,
                            child: Text(context.tr('checkResult')),
                          ),
                          if ({
                            'ready',
                            'generating',
                            'error',
                          }.contains(plan['status']))
                            TextButton(
                              onPressed:
                                  controller.busy || controller.pending != null
                                  ? null
                                  : () async {
                                      if (await confirm(
                                            context,
                                            'mobileCollaborationCancelConfirm',
                                          ) &&
                                          mounted &&
                                          controller.active) {
                                        await controller.cancelPlan();
                                      }
                                    },
                              child: Text(
                                context.tr('mobileCollaborationCancel'),
                              ),
                            ),
                          TextButton(
                            onPressed:
                                controller.busy || controller.pending != null
                                ? null
                                : () => selectPlan(null),
                            child: Text(context.tr('mobileCollaborationNew')),
                          ),
                        ],
                      ),
                    ],
                    const SizedBox(height: 16),
                    ExpansionTile(
                      title: Text(context.tr('mobileCollaborationHistory')),
                      children: [
                        TextButton(
                          onPressed: controller.busy
                              ? null
                              : controller.listHistory,
                          child: Text(context.tr('refresh')),
                        ),
                        for (final item in controller.history)
                          ListTile(
                            title: Text(
                              item['draft']?['title'] as String? ??
                                  item['goal'] as String,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            subtitle: Text(
                              context.tr(
                                'mobileCollaborationState_${item['status']}',
                              ),
                            ),
                            enabled:
                                !controller.busy && controller.pending == null,
                            onTap: () => selectPlan(item),
                          ),
                      ],
                    ),
                  ],
                ),
        ),
      );
    },
  );
}

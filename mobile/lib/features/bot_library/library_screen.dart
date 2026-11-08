import 'dart:async';
import 'package:flutter/material.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../bots/create_screen.dart';
import '../collaboration/team_plans_screen.dart';
import 'blueprint_preview.dart';
import 'install_status.dart';
import 'library_avatar.dart';
import 'shared_resources.dart';
import 'library_controller.dart';
import 'library_navigation.dart';
import 'original_bot_templates.dart';
import 'template_manager_screen.dart';

class BotLibraryScreen extends StatefulWidget {
  const BotLibraryScreen({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<BotLibraryScreen> createState() => _BotLibraryScreenState();
}

class _BotLibraryScreenState extends State<BotLibraryScreen> {
  late final LibraryController controller;
  bool leaving = false;
  @override
  void initState() {
    super.initState();
    controller = LibraryController(widget.scope);
    unawaited(controller.initialize());
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  bool get dirty =>
      controller.selected != null &&
      controller.kind == 'templates' &&
      (controller.name !=
              controller.selected!['blueprint']['profile']['name'] ||
          controller.routineMode != 'pause');
  Future<bool> discard() async =>
      !dirty || await confirm(context, 'mobileLibraryDiscard');
  Future<void> leave() async {
    if (leaving || controller.installer.busy) return;
    if (controller.installer.pending != null &&
        !await confirm(context, 'mobileLibraryLeavePending')) {
      return;
    }
    if (!mounted || !await discard() || !mounted) return;
    setState(() => leaving = true);
    Navigator.pop(context);
  }

  Future<void> install() async {
    if (controller.locked ||
        controller.selected == null ||
        controller.target == null) {
      return;
    }
    if (!await confirm(
      context,
      controller.kind == 'shared'
          ? 'mobileLibraryJoinConfirm'
          : 'mobileLibraryImportConfirm',
    )) {
      return;
    }
    if (!mounted || !controller.active) return;
    await controller.install();
  }

  Future<void> open(LibraryOpen destination) async {
    if (!mounted || !controller.active) return;
    if (destination.workspace['id'] != widget.scope.workspaceId &&
        !await confirm(context, 'mobileLibrarySwitchConfirm')) {
      return;
    }
    if (!mounted || !controller.active) return;
    setState(() => leaving = true);
    Navigator.pop(context, destination);
  }

  Future<void> browseOriginals() async {
    final scope = widget.scope;
    if (!controller.active || controller.locked) return;
    final profile = await previewOriginalBotTemplates(context, scope);
    if (profile == null ||
        !mounted ||
        !controller.active ||
        controller.locked ||
        !scope.owner) {
      return;
    }
    final id = await Navigator.push<String>(
      context,
      MaterialPageRoute(
        builder: (_) =>
            CreateScreen(scope: scope, kind: 'bot', initialProfile: profile),
      ),
    );
    if (id == null || !mounted || !controller.active) return;
    final chat = scope.find('conversations', id);
    final members = chat?['agentIds'];
    if (members is List && members.length == 1 && members.single is String) {
      await open(
        LibraryOpen(
          workspace: scope.session.workspace!,
          agentId: members.single as String,
          conversationId: id,
        ),
      );
    }
  }

  bool get canBrowseTeamTemplates =>
      controller.active &&
      !controller.locked &&
      controller.installer.ready &&
      !controller.installer.blocked &&
      widget.scope.owner;

  void browseTeamTemplates() {
    if (!canBrowseTeamTemplates || ModalRoute.of(context)?.isCurrent != true) {
      return;
    }
    Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) =>
            TeamPlansScreen(scope: widget.scope, openTeamTemplates: true),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final selected = controller.selected,
          shared = controller.kind == 'shared';
      return PopScope(
        canPop: leaving,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) unawaited(leave());
        },
        child: Scaffold(
          appBar: AppBar(
            title: Text(context.tr('mobileLibraryTitle')),
            actions: [
              if (widget.scope.owner)
                IconButton(
                  tooltip: context.tr('mobileLibraryManage'),
                  icon: const Icon(Icons.manage_accounts_outlined),
                  onPressed: controller.locked
                      ? null
                      : () async {
                          final destination = await Navigator.push<LibraryOpen>(
                            context,
                            MaterialPageRoute(
                              builder: (_) =>
                                  TemplateManagerScreen(scope: widget.scope),
                            ),
                          );
                          if (destination != null &&
                              mounted &&
                              controller.active) {
                            await open(destination);
                          }
                        },
                ),
            ],
          ),
          body: !controller.active
              ? const Notice('scopeChanged')
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (controller.error != null) Notice(controller.error!),
                    if (controller.loading ||
                        controller.installer.busy ||
                        !controller.installer.ready)
                      const LinearProgressIndicator(),
                    InstallStatus(
                      installer: controller.installer,
                      onOpen: (value) => unawaited(open(value)),
                    ),
                    SegmentedButton<String>(
                      segments: [
                        ButtonSegment(
                          value: 'templates',
                          label: Text(context.tr('mobileLibraryTemplates')),
                        ),
                        ButtonSegment(
                          value: 'shared',
                          label: Text(context.tr('mobileLibraryShared')),
                        ),
                      ],
                      selected: {controller.kind},
                      onSelectionChanged: controller.locked
                          ? null
                          : (values) async {
                              if (!await discard() ||
                                  !mounted ||
                                  !controller.active) {
                                return;
                              }
                              controller.chooseKind(values.single);
                              await controller.refresh();
                            },
                    ),
                    const SizedBox(height: 16),
                    if (!shared && selected == null)
                      OutlinedButton.icon(
                        icon: const Icon(Icons.auto_awesome_outlined),
                        onPressed: controller.locked ? null : browseOriginals,
                        label: Text(context.tr('mobileStarterTitle')),
                      ),
                    if (!shared && selected == null && widget.scope.owner)
                      OutlinedButton.icon(
                        icon: const Icon(Icons.groups_outlined),
                        onPressed: canBrowseTeamTemplates
                            ? browseTeamTemplates
                            : null,
                        label: Text(context.tr('mobileTeamStarterTitle')),
                      ),
                    Text(
                      context.tr(
                        shared
                            ? 'mobileLibrarySharedHint'
                            : 'mobileLibraryTemplateHint',
                      ),
                    ),
                    if (controller.targets.isEmpty)
                      const Notice('mobileLibraryNoTarget')
                    else
                      DropdownButtonFormField<String>(
                        key: ValueKey(
                          '${controller.kind}:${controller.targetId}',
                        ),
                        initialValue:
                            controller.target?.containsKey('id') == true
                            ? controller.targetId
                            : null,
                        isExpanded: true,
                        decoration: InputDecoration(
                          labelText: context.tr('mobileLibraryTarget'),
                        ),
                        items: controller.targets
                            .map(
                              (w) => DropdownMenuItem<String>(
                                value: w['id'],
                                child: Text(
                                  w['name'] as String? ?? '',
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            )
                            .toList(),
                        onChanged: controller.locked
                            ? null
                            : (id) async {
                                if (id == null ||
                                    !await discard() ||
                                    !mounted ||
                                    !controller.active) {
                                  return;
                                }
                                controller.chooseTarget(id);
                                await controller.refresh();
                              },
                      ),
                    const SizedBox(height: 12),
                    if (controller.installer.pending == null &&
                        selected == null) ...[
                      TextFormField(
                        key: ValueKey('search-${controller.kind}'),
                        initialValue: controller.query,
                        enabled: !controller.locked,
                        maxLength: 120,
                        decoration: InputDecoration(
                          labelText: context.tr('mobileLibrarySearch'),
                        ),
                        onChanged: controller.search,
                        onFieldSubmitted: (_) => controller.refresh(),
                      ),
                      OutlinedButton(
                        onPressed: controller.loading
                            ? null
                            : controller.refresh,
                        child: Text(context.tr('refresh')),
                      ),
                      if (!controller.loading &&
                          controller.items.isEmpty &&
                          controller.installer.ready)
                        const Notice('mobileLibraryEmpty'),
                      for (final item in controller.items)
                        Card(
                          child: ListTile(
                            title: Text(item['name'] as String),
                            subtitle: Text(
                              '${item['role']}\n${shared ? item['teamName'] : context.tr('mobileLibraryAudience_${item['audience']}')}',
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => controller.preview(item),
                          ),
                        ),
                    ],
                    if (selected != null &&
                        controller.installer.pending == null) ...[
                      TextButton(
                        onPressed: controller.loading
                            ? null
                            : () async {
                                if (await discard() && mounted) {
                                  controller.closePreview();
                                }
                              },
                        child: Text(context.tr('mobileLibraryBack')),
                      ),
                      if (shared) ...[
                        LibraryAvatar(
                          scope: widget.scope,
                          profile: selected,
                          path: selected['avatarPath'],
                          expectedImage: selected['avatarPath'] != null,
                        ),
                        Text(
                          selected['name'],
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        Text(selected['role']),
                        SelectableText(selected['description']),
                        Text(
                          '${selected['ownerName']} · ${selected['teamName']}',
                        ),
                        Text(
                          '${context.tr('skills')}: ${selected['skillCount'] ?? 0} · ${context.tr('mobileLibraryFiles')}: ${selected['fileCount'] ?? 0} · ${context.tr('mobileLibraryApps')}: ${selected['appCount'] ?? 0}',
                        ),
                        SharedResources(controller: controller),
                      ] else ...[
                        Text(
                          context.tr(
                            'mobileLibraryAudience_${selected['audience']}',
                          ),
                        ),
                        BlueprintPreview(
                          scope: widget.scope,
                          blueprint: selected['blueprint'],
                          avatarPath: selected['avatarPath'],
                        ),
                        TextFormField(
                          key: ValueKey(
                            'name-${selected['token']}:${selected['revision']}',
                          ),
                          initialValue: controller.name,
                          enabled: !controller.locked,
                          maxLength: 40,
                          decoration: InputDecoration(
                            labelText: context.tr('mobileLibraryNewName'),
                          ),
                          onChanged: (v) => setState(() => controller.name = v),
                        ),
                        RoutineInstallChoice(
                          value: controller.routineMode,
                          enabled: !controller.locked,
                          onChanged: (v) =>
                              setState(() => controller.routineMode = v),
                        ),
                      ],
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed:
                            controller.target != null &&
                                !controller.loading &&
                                !controller.installer.blocked &&
                                controller.installer.ready
                            ? install
                            : null,
                        child: Text(
                          context.tr(
                            shared
                                ? 'mobileLibraryJoin'
                                : 'mobileLibraryImport',
                          ),
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

import 'dart:async';
import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'blueprint_editor.dart';
import 'blueprint_preview.dart';
import 'install_status.dart';
import 'template_manager.dart';
import 'template_operation_status.dart';
import 'sharing_policy_screen.dart';
import 'library_navigation.dart';
import 'live_sharing_screen.dart';

class TemplateManagerScreen extends StatefulWidget {
  const TemplateManagerScreen({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<TemplateManagerScreen> createState() => _TemplateManagerScreenState();
}

class _TemplateManagerScreenState extends State<TemplateManagerScreen> {
  late final TemplateManager controller;
  String name = '', mode = 'pause', audience = 'public';
  Json? draft;
  bool leaving = false;
  @override
  void initState() {
    super.initState();
    controller = TemplateManager(widget.scope);
    unawaited(controller.initialize());
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> leave() async {
    if (controller.busy ||
        controller.operation.busy ||
        controller.installer.busy) {
      return;
    }
    if (draft != null && !await confirm(context, 'mobileLibraryEditDiscard')) {
      return;
    }
    if ((controller.operation.pending != null ||
            controller.installer.pending != null) &&
        mounted &&
        !await confirm(context, 'mobileLibraryLeavePending')) {
      return;
    }
    if (mounted) {
      setState(() => leaving = true);
      Navigator.pop(context);
    }
  }

  Future<void> chooseSource(String id) async {
    await controller.previewSource(id);
    if (mounted && controller.active && controller.source != null) {
      setState(() {
        name = controller.source!['blueprint']['profile']['name'];
        mode = 'pause';
        draft = null;
      });
    }
  }

  Future<void> edit() async {
    final t = controller.selected;
    if (t == null) return;
    final next = await Navigator.push<Json>(
      context,
      MaterialPageRoute(
        builder: (_) => BlueprintEditor(initial: draft ?? t['blueprint']),
      ),
    );
    if (next != null && mounted && controller.active && !controller.locked) {
      setState(() => draft = next);
    }
  }

  Future<void> change(String kind, String question) async {
    if (!await confirm(context, question) || !mounted || !controller.active) {
      return;
    }
    await controller.change(kind, draft: draft, audience: audience);
    if (mounted && controller.operation.pending != null) {
      setState(() => draft = null);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final t = controller.selected, s = controller.source;
      return PopScope(
        canPop: leaving,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) unawaited(leave());
        },
        child: Scaffold(
          appBar: AppBar(
            title: Text(context.tr('mobileLibraryManage')),
            actions: [
              IconButton(
                tooltip: context.tr('mobileLibraryPolicy'),
                icon: const Icon(Icons.policy_outlined),
                onPressed: controller.locked
                    ? null
                    : () => Navigator.push(
                        context,
                        MaterialPageRoute<void>(
                          builder: (_) =>
                              SharingPolicyScreen(scope: widget.scope),
                        ),
                      ),
              ),
            ],
          ),
          body: !controller.active
              ? const Notice('scopeChanged')
              : !widget.scope.owner
              ? const Notice('readOnly')
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (controller.busy ||
                        controller.operation.busy ||
                        controller.installer.busy)
                      const LinearProgressIndicator(),
                    if (controller.error != null) Notice(controller.error!),
                    TemplateOperationStatus(manager: controller),
                    InstallStatus(
                      installer: controller.installer,
                      onOpen: (LibraryOpen value) {
                        if (mounted && controller.active) {
                          setState(() => leaving = true);
                          Navigator.pop(context, value);
                        }
                      },
                    ),
                    if (controller.operation.pending == null &&
                        controller.installer.pending == null) ...[
                      const Notice('mobileLibraryManageHint'),
                      if (t == null && s == null) ...[
                        OutlinedButton(
                          onPressed: controller.locked
                              ? null
                              : controller.refresh,
                          child: Text(context.tr('refresh')),
                        ),
                        Text(
                          context.tr('mobileLibrarySources'),
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        for (final bot in controller.bots)
                          Card(
                            child: ListTile(
                              title: Text(bot['name']),
                              subtitle: Text(bot['role']),
                              trailing: const Icon(Icons.chevron_right),
                              onTap: controller.locked
                                  ? null
                                  : () => chooseSource(bot['id']),
                            ),
                          ),
                        Text(
                          context.tr('mobileLibraryMyTemplates'),
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        if (controller.templates.isEmpty)
                          const Notice('mobileLibraryEmpty'),
                        for (final row in controller.templates)
                          Card(
                            child: ListTile(
                              title: Text(row['blueprint']['profile']['name']),
                              subtitle: Text(
                                context.tr(
                                  row['publication'] == null
                                      ? 'mobileLibraryUnpublished'
                                      : 'mobileLibraryPublished',
                                ),
                              ),
                              onTap: controller.locked
                                  ? null
                                  : () => controller.previewTemplate(row['id']),
                            ),
                          ),
                      ] else ...[
                        TextButton(
                          onPressed: controller.locked
                              ? null
                              : () async {
                                  if (draft != null &&
                                      !await confirm(
                                        context,
                                        'mobileLibraryEditDiscard',
                                      )) {
                                    return;
                                  }
                                  if (mounted && controller.active) {
                                    setState(() {
                                      draft = null;
                                      controller.selected = null;
                                      controller.source = null;
                                    });
                                  }
                                },
                          child: Text(context.tr('mobileLibraryBack')),
                        ),
                        if (t == null && s != null) ...[
                          BlueprintPreview(
                            scope: widget.scope,
                            blueprint: s['blueprint'],
                            avatarPath: s['avatarPath'],
                          ),
                          TextFormField(
                            key: ValueKey(controller.sourceId),
                            initialValue: name,
                            maxLength: 40,
                            enabled: !controller.locked,
                            decoration: InputDecoration(
                              labelText: context.tr('mobileLibraryNewName'),
                            ),
                            onChanged: (v) => setState(() => name = v),
                          ),
                          RoutineInstallChoice(
                            value: mode,
                            enabled: !controller.locked,
                            onChanged: (v) => setState(() => mode = v),
                          ),
                          FilledButton(
                            onPressed: controller.locked || name.trim().isEmpty
                                ? null
                                : () async {
                                    if (await confirm(
                                          context,
                                          'mobileLibraryCopyConfirm',
                                        ) &&
                                        controller.active) {
                                      await controller.copy(name, mode);
                                    }
                                  },
                            child: Text(context.tr('mobileLibraryCopy')),
                          ),
                          OutlinedButton(
                            onPressed: controller.locked
                                ? null
                                : () => Navigator.push(
                                    context,
                                    MaterialPageRoute<void>(
                                      builder: (_) => LiveSharingScreen(
                                        scope: widget.scope,
                                        agentId: controller.sourceId!,
                                      ),
                                    ),
                                  ),
                            child: Text(context.tr('mobileLibraryLiveSharing')),
                          ),
                          OutlinedButton(
                            onPressed:
                                controller.locked ||
                                    controller.conversationId == null
                                ? null
                                : () async {
                                    if (await confirm(
                                          context,
                                          'mobileLibraryCreateConfirm',
                                        ) &&
                                        controller.active) {
                                      await controller.create();
                                    }
                                  },
                            child: Text(
                              context.tr('mobileLibraryCreateTemplate'),
                            ),
                          ),
                          if (controller.conversationId == null)
                            const Notice('mobileLibraryUniqueChat'),
                        ],
                        if (t != null) ...[
                          if (draft != null)
                            const Notice('mobileLibraryReviewDraft'),
                          BlueprintPreview(
                            scope: widget.scope,
                            blueprint: draft ?? t['blueprint'],
                            avatarPath: t['avatarPath'],
                          ),
                          if (t['publication'] != null)
                            SelectableText(
                              '${context.tr('mobileLibraryPublished')}: ${t['publication']['audience']}\n${t['publication']['path']}',
                            ),
                          OutlinedButton(
                            onPressed: controller.locked ? null : edit,
                            child: Text(context.tr('mobileLibraryEditDraft')),
                          ),
                          if (draft != null)
                            FilledButton(
                              onPressed: controller.locked
                                  ? null
                                  : () => change(
                                      'Edit',
                                      'mobileLibrarySaveConfirm',
                                    ),
                              child: Text(context.tr('save')),
                            ),
                          if (draft == null) ...[
                            DropdownButtonFormField<String>(
                              initialValue: audience,
                              isExpanded: true,
                              decoration: InputDecoration(
                                labelText: context.tr(
                                  'mobileLibraryPublishAudience',
                                ),
                              ),
                              items: [
                                for (final a in [
                                  'public',
                                  if (widget.scope.session.workspace?['kind'] ==
                                      'team')
                                    'team',
                                ])
                                  DropdownMenuItem(
                                    value: a,
                                    child: Text(
                                      context.tr(
                                        'mobileLibraryAudienceShort_$a',
                                      ),
                                    ),
                                  ),
                              ],
                              onChanged: controller.locked
                                  ? null
                                  : (v) => setState(
                                      () => audience = v ?? audience,
                                    ),
                            ),
                            FilledButton(
                              onPressed: controller.locked
                                  ? null
                                  : () => change(
                                      'Publish',
                                      'mobileLibraryPublishConfirm',
                                    ),
                              child: Text(context.tr('mobileLibraryPublish')),
                            ),
                            if (t['publication'] != null)
                              TextButton(
                                onPressed: controller.locked
                                    ? null
                                    : () => change(
                                        'Revoke',
                                        'mobileLibraryRevokeConfirm',
                                      ),
                                child: Text(context.tr('mobileLibraryRevoke')),
                              ),
                            OutlinedButton(
                              onPressed: controller.locked
                                  ? null
                                  : controller.previewRefresh,
                              child: Text(
                                context.tr('mobileLibraryPreviewSource'),
                              ),
                            ),
                            if (s != null) ...[
                              const Notice('mobileLibraryRefreshHint'),
                              BlueprintPreview(
                                scope: widget.scope,
                                blueprint: s['blueprint'],
                                avatarPath: s['avatarPath'],
                              ),
                              OutlinedButton(
                                onPressed: controller.locked
                                    ? null
                                    : () => change(
                                        'Refresh',
                                        'mobileLibraryRefreshConfirm',
                                      ),
                                child: Text(
                                  context.tr('mobileLibraryRefreshDraft'),
                                ),
                              ),
                            ],
                          ],
                        ],
                      ],
                    ],
                  ],
                ),
        ),
      );
    },
  );
}

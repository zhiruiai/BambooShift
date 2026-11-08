import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'model_profile_editor.dart';
import 'model_profiles_controller.dart';

class ModelSettings extends StatefulWidget {
  const ModelSettings({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<ModelSettings> createState() => _ModelSettingsState();
}

class _ModelSettingsState extends State<ModelSettings> {
  late final ModelProfilesController controller;
  @override
  void initState() {
    super.initState();
    controller = ModelProfilesController(widget.scope);
    unawaited(controller.initialize());
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  void edit([Json? profile, bool copy = false]) {
    if (!controller.active || controller.busy || controller.loading) return;
    if (profile == null && !controller.canManage) return;
    final initial = copy
        ? {
            ...profile!,
            'name':
                '${(profile['name'] as String).substring(0, (profile['name'] as String).length.clamp(0, 60))} ${context.tr('mobileModelsCopySuffix')}',
          }
        : profile;
    Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => ModelProfileEditor(
          controller: controller,
          profile: initial,
          copy: copy,
        ),
      ),
    );
  }

  Future<void> decide(Json profile, String kind) async {
    if (!controller.canManage) return;
    final label = kind == 'activate'
        ? 'mobileModelsActivateConfirm'
        : 'mobileModelsDeleteConfirm';
    if (!await confirm(context, '${context.tr(label)}\n${profile['name']}')) {
      return;
    }
    if (!mounted || !controller.canManage) return;
    await controller.write(kind, id: profile['id'] as String);
  }

  Future<void> acknowledge() async {
    if (!await confirm(context, 'mobileModelsAcknowledgeConfirm')) return;
    if (!mounted || !controller.active) return;
    await controller.acknowledge();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([controller, widget.scope.session]),
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        title: Text(context.tr('mobileModelsLibrary')),
        actions: [
          IconButton(
            tooltip: context.tr('refresh'),
            onPressed: controller.busy || controller.loading
                ? null
                : controller.refresh,
            icon: const Icon(Icons.refresh),
          ),
          if (widget.scope.owner)
            IconButton(
              tooltip: context.tr('mobileModelsNew'),
              onPressed: controller.canManage ? () => edit() : null,
              icon: const Icon(Icons.add),
            ),
        ],
      ),
      body: !controller.active
          ? const Notice('scopeChanged')
          : RefreshIndicator(
              onRefresh: controller.refresh,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                children: [
                  if (!widget.scope.owner)
                    const Notice('mobileModelsMemberReadOnly'),
                  if (controller.loading || controller.busy)
                    const LinearProgressIndicator(),
                  if (controller.error != null) Notice(controller.error!),
                  if (controller.notice != null) Notice(controller.notice!),
                  if (controller.pending != null) ...[
                    const Notice('mobileModelsUnknown'),
                    TextButton(
                      onPressed:
                          controller.checked &&
                              !controller.busy &&
                              !controller.loading
                          ? acknowledge
                          : null,
                      child: Text(context.tr('mobileModelsAcknowledge')),
                    ),
                  ],
                  if (controller.profiles.isEmpty && !controller.loading)
                    const Notice('mobileModelsEmpty'),
                  for (final profile in controller.profiles)
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              profile['name'] as String,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 6),
                            Text(
                              '${profile['provider']} · ${profile['model']}',
                              style: const TextStyle(fontSize: 14),
                            ),
                            if (controller.activeId == profile['id'])
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 6,
                                ),
                                child: Text(
                                  context.tr('mobileModelsDefault'),
                                  style: const TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            Text(
                              context.tr(
                                profile['hasApiKey'] == true
                                    ? 'mobileModelsKeySaved'
                                    : 'mobileModelsNoKey',
                              ),
                              style: const TextStyle(fontSize: 13),
                            ),
                            if (profile['baseUrl'] != '')
                              SelectableText(
                                profile['baseUrl'] as String,
                                style: const TextStyle(fontSize: 13),
                              ),
                            Wrap(
                              spacing: 8,
                              children: [
                                TextButton(
                                  onPressed:
                                      controller.busy || controller.loading
                                      ? null
                                      : () => edit(profile),
                                  child: Text(
                                    context.tr(
                                      widget.scope.owner
                                          ? 'edit'
                                          : 'mobileModelsView',
                                    ),
                                  ),
                                ),
                                if (widget.scope.owner) ...[
                                  TextButton(
                                    onPressed: controller.canManage
                                        ? () => edit(profile, true)
                                        : null,
                                    child: Text(context.tr('mobileModelsCopy')),
                                  ),
                                  if (controller.activeId != profile['id']) ...[
                                    TextButton(
                                      onPressed: controller.canManage
                                          ? () => decide(profile, 'activate')
                                          : null,
                                      child: Text(
                                        context.tr('mobileModelsActivate'),
                                      ),
                                    ),
                                    IconButton(
                                      tooltip: context.tr('delete'),
                                      onPressed:
                                          controller.canManage &&
                                              controller.profiles.length > 1
                                          ? () => decide(profile, 'delete')
                                          : null,
                                      icon: const Icon(Icons.delete_outline),
                                    ),
                                  ],
                                ],
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  const Notice('mobileModelsSaveSeparate'),
                ],
              ),
            ),
    ),
  );
}

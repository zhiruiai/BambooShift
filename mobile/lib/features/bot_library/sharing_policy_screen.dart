import 'dart:async';
import 'package:flutter/material.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'sharing_policy_controller.dart';

class SharingPolicyScreen extends StatefulWidget {
  const SharingPolicyScreen({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<SharingPolicyScreen> createState() => _SharingPolicyScreenState();
}

class _SharingPolicyScreenState extends State<SharingPolicyScreen> {
  late final SharingPolicyController controller;
  @override
  void initState() {
    super.initState();
    controller = SharingPolicyController(widget.scope);
    unawaited(controller.initialize());
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => Scaffold(
      appBar: AppBar(title: Text(context.tr('mobileLibraryPolicy'))),
      body: !controller.active
          ? const Notice('scopeChanged')
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                const Notice('mobileLibraryPolicyHint'),
                if (controller.busy) const LinearProgressIndicator(),
                if (controller.error != null) Notice(controller.error!),
                if (controller.unknown) ...[
                  const Notice('mobileLibraryPolicyUnknown'),
                  OutlinedButton(
                    onPressed: controller.busy ? null : controller.refresh,
                    child: Text(context.tr('refresh')),
                  ),
                  TextButton(
                    onPressed: controller.busy
                        ? null
                        : () async {
                            if (await confirm(
                                  context,
                                  'mobileLibraryPolicyAcknowledgeConfirm',
                                ) &&
                                controller.active) {
                              await controller.acknowledge();
                            }
                          },
                    child: Text(context.tr('mobileLibraryAcknowledgeCurrent')),
                  ),
                ],
                if (controller.policy != null) ...[
                  Text(
                    '${context.tr('mobileLibraryPolicyCurrent')}: ${context.tr('mobileLibraryPolicy_${controller.policy!['mode']}')}',
                  ),
                  DropdownButtonFormField<String>(
                    key: ValueKey(controller.policy!['revision']),
                    initialValue: controller.mode,
                    isExpanded: true,
                    items: [
                      for (final m in [
                        'public',
                        if (widget.scope.session.workspace?['kind'] == 'team')
                          'team-only',
                        'disabled',
                      ])
                        DropdownMenuItem(
                          value: m,
                          child: Text(context.tr('mobileLibraryPolicy_$m')),
                        ),
                    ],
                    onChanged: controller.busy || controller.unknown
                        ? null
                        : (v) => setState(
                            () => controller.mode = v ?? controller.mode,
                          ),
                  ),
                  FilledButton(
                    onPressed:
                        controller.busy ||
                            controller.unknown ||
                            !controller.ready ||
                            controller.mode == controller.policy!['mode']
                        ? null
                        : () async {
                            if (await confirm(
                                  context,
                                  'mobileLibraryPolicyConfirm',
                                ) &&
                                controller.active) {
                              await controller.save();
                            }
                          },
                    child: Text(context.tr('save')),
                  ),
                ],
              ],
            ),
    ),
  );
}

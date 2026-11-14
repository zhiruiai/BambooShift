import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../settings/model_profiles_controller.dart';
import '../settings/model_settings.dart';

class BotModelPicker extends StatefulWidget {
  const BotModelPicker({
    super.key,
    required this.scope,
    required this.value,
    required this.enabled,
    required this.onChanged,
    this.managed = false,
  });

  final WorkspaceController scope;
  final String? value;
  final bool enabled, managed;
  final ValueChanged<String?> onChanged;

  @override
  State<BotModelPicker> createState() => _BotModelPickerState();
}

class _BotModelPickerState extends State<BotModelPicker> {
  late final model = ModelProfilesController(widget.scope);

  @override
  void initState() {
    super.initState();
    if (widget.scope.owner && !widget.managed) {
      unawaited(model.initialize());
    }
  }

  @override
  void dispose() {
    model.dispose();
    super.dispose();
  }

  Future<void> manage() async {
    if (!widget.enabled || !model.active || !widget.scope.owner) return;
    await Navigator.push<void>(
      context,
      MaterialPageRoute(builder: (_) => ModelSettings(scope: widget.scope)),
    );
    if (mounted && model.active) await model.refresh();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([model, widget.scope, widget.scope.session]),
    builder: (context, _) {
      if (!model.active) return const SizedBox.shrink();
      final selected = widget.value ?? '';
      final profiles = model.profiles
          .where((profile) => profile['configured'] == true)
          .toList();
      final missing =
          selected.isNotEmpty &&
          !profiles.any((profile) => profile['id'] == selected);
      final canEdit =
          widget.enabled &&
          widget.scope.owner &&
          !widget.managed &&
          model.checked &&
          !model.loading;
      return Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.managed || !widget.scope.owner)
              InputDecorator(
                decoration: InputDecoration(
                  labelText: context.tr('mobileBotModel'),
                ),
                child: Text(
                  context.tr(
                    widget.managed
                        ? 'mobileBotModelShared'
                        : selected.isEmpty
                        ? 'mobileBotModelDefault'
                        : 'mobileBotModelAssigned',
                  ),
                ),
              )
            else ...[
              DropdownButtonFormField<String>(
                key: ValueKey(selected),
                initialValue: selected,
                isExpanded: true,
                menuMaxHeight: 320,
                onTap: () => FocusScope.of(context).unfocus(),
                decoration: InputDecoration(
                  labelText: context.tr('mobileBotModel'),
                ),
                items: [
                  DropdownMenuItem(
                    value: '',
                    child: Text(
                      context.tr('mobileBotModelDefault'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  for (final profile in profiles)
                    DropdownMenuItem(
                      value: profile['id'] as String,
                      child: Text(
                        '${profile['name']} · ${profile['model']}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  if (missing)
                    DropdownMenuItem(
                      value: selected,
                      enabled: false,
                      child: Text(
                        context.tr('mobileBotModelUnavailable'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: canEdit
                    ? (value) {
                        if (value != null && model.active && widget.enabled) {
                          widget.onChanged(value.isEmpty ? null : value);
                        }
                      }
                    : null,
              ),
              const SizedBox(height: 8),
              Text(
                context.tr('mobileBotModelHelp'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (model.loading) const LinearProgressIndicator(),
              if (model.error != null)
                Notice(
                  model.error!,
                  action: 'refresh',
                  onAction: model.loading ? null : model.refresh,
                ),
              if (missing && model.checked)
                const Notice('mobileBotModelMissingHelp'),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton.icon(
                  onPressed: widget.enabled ? manage : null,
                  icon: const Icon(Icons.tune, size: 18),
                  label: Text(context.tr('mobileModelsLibrary')),
                ),
              ),
            ],
          ],
        ),
      );
    },
  );
}

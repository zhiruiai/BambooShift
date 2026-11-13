import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/avatar_palette.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import 'avatar_crop_dialog.dart';

class BotForm extends StatefulWidget {
  const BotForm({
    super.key,
    required this.initial,
    required this.enabled,
    required this.family,
    required this.onChanged,
    this.avatarScope,
    this.avatarTargetCurrent,
    this.sharedAvatar,
  });
  final Json initial;
  final bool enabled;
  final String family;
  final ValueChanged<Json> onChanged;
  final WorkspaceController? avatarScope;
  final bool Function()? avatarTargetCurrent;
  final Object? sharedAvatar;
  @override
  State<BotForm> createState() => _BotFormState();
}

class _BotFormState extends State<BotForm> {
  late Json draft;
  @override
  void initState() {
    super.initState();
    draft = {
      'name': '',
      'role': '',
      'description': '',
      'instructions': '',
      'avatar': 'orb',
      'color': defaultAvatarColor,
      ...widget.initial,
    };
  }

  void change(String key, Object? value) {
    setState(() => draft[key] = value);
    widget.onChanged(Map.of(draft));
  }

  Future<void> editAvatar(WorkspaceController scope) async {
    final target = widget.avatarTargetCurrent;
    bool current() =>
        mounted &&
        identical(widget.avatarScope, scope) &&
        scope.active &&
        scope.owner &&
        widget.enabled &&
        (target?.call() ?? true);
    if (!current()) return;
    final asset = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (_) => AvatarCropDialog(scope: scope, targetCurrent: current),
    );
    if (asset != null && current()) {
      change('avatarImageId', asset);
    }
  }

  Widget field(String key, int max, {int lines = 1}) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: TextFormField(
      initialValue: draft[key] as String? ?? '',
      enabled: widget.enabled,
      maxLength: max,
      minLines: lines,
      maxLines: lines == 1 ? 1 : 8,
      decoration: InputDecoration(labelText: context.tr(key)),
      onChanged: (value) => change(key, value),
      validator: (value) =>
          ['name', 'role'].contains(key) && (value ?? '').trim().isEmpty
          ? context.tr('required')
          : null,
    ),
  );
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      field('name', 40),
      field('role', 80),
      field('description', 1000, lines: 2),
      field('instructions', 16000, lines: 4),
      Text(
        context.tr('avatar'),
        style: Theme.of(context).textTheme.titleMedium,
      ),
      const SizedBox(height: 8),
      if (widget.avatarScope case final WorkspaceController scope) ...[
        BotAvatar(
          bot: {
            ...draft,
            if (widget.sharedAvatar != null) 'sharedBot': widget.sharedAvatar,
          },
          family: widget.family,
          scope: scope,
          size: 68,
        ),
        if (widget.enabled) ...[
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              OutlinedButton.icon(
                onPressed: () => editAvatar(scope),
                icon: const Icon(Icons.image_outlined),
                label: Text(context.tr('avatarUpload')),
              ),
              if (draft['avatarImageId'] != null)
                TextButton(
                  onPressed: () => change('avatarImageId', null),
                  child: Text(context.tr('avatarRestore')),
                ),
            ],
          ),
        ],
        const SizedBox(height: 8),
      ],
      Wrap(
        spacing: 8,
        children: ['orb', 'drop', 'leaf', 'spark', 'gem', 'arch']
            .map(
              (shape) => Semantics(
                button: true,
                selected: draft['avatar'] == shape,
                label: shape,
                child: InkWell(
                  onTap: widget.enabled ? () => change('avatar', shape) : null,
                  borderRadius: BorderRadius.circular(12),
                  child: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        width: 2,
                        color: draft['avatar'] == shape
                            ? Theme.of(context).colorScheme.primary
                            : Colors.transparent,
                      ),
                    ),
                    child: BotAvatar(
                      bot: {'avatar': shape, 'color': draft['color']},
                      family: widget.family,
                    ),
                  ),
                ),
              ),
            )
            .toList(),
      ),
      const SizedBox(height: 16),
      Text(context.tr('color'), style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 8),
      Wrap(
        spacing: 10,
        children: avatarColors
            .map(
              (hex) => Semantics(
                button: true,
                selected:
                    displayAvatarColor(draft['color']).toLowerCase() ==
                    hex.toLowerCase(),
                label: hex,
                child: InkWell(
                  onTap: widget.enabled ? () => change('color', hex) : null,
                  child: Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: avatarColorValue(hex),
                      shape: BoxShape.circle,
                    ),
                    child:
                        displayAvatarColor(draft['color']).toLowerCase() ==
                            hex.toLowerCase()
                        ? const Icon(Icons.check, color: Colors.white)
                        : null,
                  ),
                ),
              ),
            )
            .toList(),
      ),
    ],
  );
}

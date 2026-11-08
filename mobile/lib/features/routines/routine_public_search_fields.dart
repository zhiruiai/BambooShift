import 'package:flutter/material.dart';

import '../../core/routine_public_search.dart';
import '../../l10n/strings.dart';

class RoutinePublicSearchFields extends StatefulWidget {
  const RoutinePublicSearchFields({
    super.key,
    required this.approved,
    required this.editable,
    required this.onChanged,
  });
  final List<String> approved;
  final bool editable;
  final ValueChanged<List<String>?> onChanged;

  @override
  State<RoutinePublicSearchFields> createState() =>
      _RoutinePublicSearchFieldsState();
}

class _RoutinePublicSearchFieldsState extends State<RoutinePublicSearchFields> {
  late bool _enabled = widget.approved.isNotEmpty;
  late String _text = widget.approved.join('\n');

  List<String>? _phrases(String text) {
    final lines = text
        .split(RegExp(r'\r\n|\r|\n'))
        .where((line) => line.trim().isNotEmpty)
        .toList();
    return lines.isEmpty ? null : normalizeRoutinePublicQueries(lines);
  }

  void _emit() => widget.onChanged(_enabled ? _phrases(_text) : const []);

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 8),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(context.tr('routinePublicSearchToggle')),
          value: _enabled,
          onChanged: widget.editable
              ? (value) {
                  setState(() => _enabled = value);
                  _emit();
                }
              : null,
        ),
        if (_enabled) ...[
          Text(context.tr('routinePublicSearchScope')),
          const SizedBox(height: 12),
          TextFormField(
            initialValue: _text,
            enabled: widget.editable,
            minLines: 2,
            maxLines: 5,
            keyboardType: TextInputType.multiline,
            decoration: InputDecoration(
              labelText: context.tr('routinePublicSearchPhrases'),
            ),
            validator: (value) => _phrases(value ?? '') == null
                ? context.tr('routinePublicSearchInvalid')
                : null,
            onChanged: (value) {
              _text = value;
              _emit();
            },
          ),
        ],
      ],
    );
  }
}

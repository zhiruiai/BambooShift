import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';

Future<String?> rosterName(BuildContext context, {String value = ''}) =>
    showDialog<String>(
      context: context,
      builder: (_) => _RosterNameDialog(value: value),
    );

class _RosterNameDialog extends StatefulWidget {
  const _RosterNameDialog({required this.value});
  final String value;
  @override
  State<_RosterNameDialog> createState() => _RosterNameDialogState();
}

class _RosterNameDialogState extends State<_RosterNameDialog> {
  late final input = TextEditingController(text: widget.value);
  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final text = input.text.trim();
    final valid =
        text.isNotEmpty &&
        text.runes.length <= 80 &&
        !RegExp(r'[\x00-\x1f\x7f\u2028\u2029]').hasMatch(text);
    return AlertDialog(
      title: Text(context.tr('mobileRosterSectionName')),
      scrollable: true,
      content: TextField(
        controller: input,
        autofocus: true,
        maxLength: 80,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          labelText: context.tr('mobileRosterSectionName'),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(context.tr('cancel')),
        ),
        FilledButton(
          onPressed: valid ? () => Navigator.pop(context, text) : null,
          child: Text(context.tr('save')),
        ),
      ],
    );
  }
}

Future<String?> rosterDestination(BuildContext context, List<Json> sections) =>
    showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * .7,
          ),
          child: ListView(
            shrinkWrap: true,
            children: [
              ListTile(title: Text(context.tr('mobileRosterMove'))),
              ListTile(
                title: Text(context.tr('mobileRosterOther')),
                onTap: () => Navigator.pop(context, ''),
              ),
              for (final section in sections)
                ListTile(
                  title: Text(section['name'] as String),
                  onTap: () => Navigator.pop(context, section['id'] as String),
                ),
            ],
          ),
        ),
      ),
    );

Future<bool> rosterConfirm(BuildContext context, String text) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(context.tr('mobileRosterTitle')),
        content: Text(context.tr(text)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(context.tr('cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(context.tr('mobileRosterConfirm')),
          ),
        ],
      ),
    ) ??
    false;

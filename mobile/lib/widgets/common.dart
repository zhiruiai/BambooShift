import 'package:flutter/material.dart';

import '../l10n/strings.dart';

class Notice extends StatelessWidget {
  const Notice(this.message, {super.key, this.action, this.onAction});
  final String message;
  final String? action;
  final VoidCallback? onAction;
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.symmetric(vertical: 8),
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: Theme.of(
        context,
      ).colorScheme.secondaryContainer.withValues(alpha: .5),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(context.tr(message), style: const TextStyle(fontSize: 14)),
        if (action != null)
          TextButton(onPressed: onAction, child: Text(context.tr(action!))),
      ],
    ),
  );
}

Future<bool> confirm(BuildContext context, String message) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(context.tr(message)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(context.tr('cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(context.tr('done')),
          ),
        ],
      ),
    ) ??
    false;

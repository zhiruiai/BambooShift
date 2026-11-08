import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import 'apps_controller.dart';

class AppTokenPrompt extends StatefulWidget {
  const AppTokenPrompt({super.key, required this.controller});
  final AppsController controller;
  @override
  State<AppTokenPrompt> createState() => _AppTokenPromptState();
}

class _AppTokenPromptState extends State<AppTokenPrompt> {
  final field = TextEditingController();
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(changed);
  }

  void changed() {
    if (!widget.controller.active || !widget.controller.scope.owner) {
      field.clear();
      if (mounted) setState(() {});
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(changed);
    field.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(context.tr('mobileAppsReconnect')),
    content: TextField(
      controller: field,
      enabled: widget.controller.active && widget.controller.scope.owner,
      obscureText: true,
      autocorrect: false,
      enableSuggestions: false,
      decoration: InputDecoration(
        labelText: context.tr('mobileAppsToken'),
        helperText: context.tr('mobileAppsTokenKeep'),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: Text(context.tr('cancel')),
      ),
      FilledButton(
        onPressed: widget.controller.active && widget.controller.scope.owner
            ? () => Navigator.pop(context, field.text)
            : null,
        child: Text(context.tr('mobileAppsReconnect')),
      ),
    ],
  );
}

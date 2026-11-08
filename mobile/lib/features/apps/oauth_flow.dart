import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'apps_controller.dart';
import 'apps_data.dart';

class OAuthFlowPanel extends StatefulWidget {
  const OAuthFlowPanel({
    super.key,
    required this.controller,
    required this.connectionId,
  });
  final AppsController controller;
  final String connectionId;
  @override
  State<OAuthFlowPanel> createState() => _OAuthFlowPanelState();
}

class _OAuthFlowPanelState extends State<OAuthFlowPanel>
    with WidgetsBindingObserver {
  final clientId = TextEditingController(),
      clientSecret = TextEditingController();
  Timer? poll;
  bool foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(changed);
    poll = Timer.periodic(const Duration(seconds: 5), (_) {
      final flow = widget.controller.flows[widget.connectionId];
      if (foreground && flow != null && !terminalFlow(flow)) {
        unawaited(widget.controller.refresh(widget.connectionId));
      }
    });
  }

  void changed() {
    if (!widget.controller.active || !widget.controller.scope.owner) {
      clientId.clear();
      clientSecret.clear();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = state == AppLifecycleState.resumed;
    if (foreground) unawaited(widget.controller.refresh(widget.connectionId));
  }

  @override
  void dispose() {
    poll?.cancel();
    widget.controller.removeListener(changed);
    WidgetsBinding.instance.removeObserver(this);
    clientId.dispose();
    clientSecret.dispose();
    super.dispose();
  }

  Future<void> start() async {
    await widget.controller.startOAuth(
      widget.connectionId,
      clientId: clientId.text.trim(),
      clientSecret: clientSecret.text,
    );
    if (mounted) clientSecret.clear();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, id = widget.connectionId;
    final flow = c.flows[id];
    final terminal = flow == null || terminalFlow(flow);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              context.tr('mobileAppsOAuthTitle'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(context.tr('mobileAppsBrowserAccount')),
            if (flow != null) ...[
              const SizedBox(height: 12),
              Text(context.tr('mobileAppsFlow_${flow['status']}')),
              if (flow['authorizationOrigin'] is String)
                SelectableText(flow['authorizationOrigin']),
              if ((flow['scopes'] as List).isNotEmpty)
                SelectableText((flow['scopes'] as List).join(', ')),
              if (flow['error'] is String) Notice(flow['error']),
            ],
            if (terminal) ...[
              ExpansionTile(
                title: Text(context.tr('mobileAppsAdvancedOAuth')),
                children: [
                  TextField(
                    controller: clientId,
                    enabled: c.canWriteConnection(id),
                    autocorrect: false,
                    decoration: InputDecoration(
                      labelText: context.tr('mobileAppsClientId'),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: clientSecret,
                    enabled: c.canWriteConnection(id),
                    obscureText: true,
                    autocorrect: false,
                    enableSuggestions: false,
                    decoration: InputDecoration(
                      labelText: context.tr('mobileAppsClientSecret'),
                    ),
                  ),
                ],
              ),
              FilledButton(
                onPressed: c.canWriteConnection(id) ? start : null,
                child: Text(context.tr('mobileAppsStartOAuth')),
              ),
            ],
            if (flow?['status'] == 'pending')
              FilledButton.icon(
                onPressed: c.canWriteConnection(id)
                    ? () => c.openOAuth(id)
                    : null,
                icon: const Icon(Icons.open_in_browser),
                label: Text(context.tr('mobileAppsOpenBrowser')),
              ),
            if (flow?['status'] == 'callback_received')
              FilledButton(
                onPressed: c.canWriteConnection(id)
                    ? () => c.finishOAuth(id)
                    : null,
                child: Text(context.tr('mobileAppsFinishOAuth')),
              ),
            if (!terminal)
              TextButton(
                onPressed: !c.busy && c.active && c.scope.owner
                    ? () async {
                        if (await confirm(context, 'mobileAppsCancelConfirm')) {
                          await c.cancelOAuth(id);
                        }
                      }
                    : null,
                child: Text(context.tr('mobileAppsCancelOAuth')),
              ),
            TextButton(
              onPressed: !c.busy && c.active ? () => c.refresh(id) : null,
              child: Text(context.tr('mobileAppsCheckOAuth')),
            ),
          ],
        ),
      ),
    );
  }
}

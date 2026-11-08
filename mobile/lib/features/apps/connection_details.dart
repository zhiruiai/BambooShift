import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'apps_controller.dart';
import 'apps_data.dart';
import 'oauth_flow.dart';
import 'pending_check.dart';
import 'token_prompt.dart';

class ConnectionDetails extends StatefulWidget {
  const ConnectionDetails({
    super.key,
    required this.controller,
    required this.connectionId,
  });
  final AppsController controller;
  final String connectionId;
  @override
  State<ConnectionDetails> createState() => _ConnectionDetailsState();
}

class _ConnectionDetailsState extends State<ConnectionDetails> {
  @override
  void initState() {
    super.initState();
    widget.controller.selectedId = widget.connectionId;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(widget.controller.refresh(widget.connectionId));
    });
  }

  @override
  void dispose() {
    if (widget.controller.selectedId == widget.connectionId) {
      widget.controller.selectedId = null;
    }
    super.dispose();
  }

  Future<void> reconnect() async {
    final controller = widget.controller;
    final app = controller.find(widget.connectionId);
    if (app == null) return;
    String? token;
    if (app['authType'] == 'bearer' ||
        (app['authType'] == 'none' && app['status'] == 'needs_auth')) {
      final accepted = await showDialog<String>(
        context: context,
        builder: (_) => AppTokenPrompt(controller: controller),
      );
      if (accepted == null || !mounted || !controller.active) return;
      token = accepted.isEmpty ? null : accepted;
    }
    await controller.change(widget.connectionId, 'reconnect', token: token);
  }

  Future<void> change(String operation, String confirmation) async {
    if (await confirm(context, confirmation) && widget.controller.active) {
      await widget.controller.change(widget.connectionId, operation);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final app = c.find(widget.connectionId);
      return Scaffold(
        appBar: AppBar(
          title: Text(app?['name'] ?? context.tr('mobileAppsTitle')),
          actions: [
            IconButton(
              tooltip: context.tr('mobileAppsRefresh'),
              onPressed: c.active && !c.busy
                  ? () => c.refresh(widget.connectionId)
                  : null,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: !c.active
            ? const Notice('scopeChanged')
            : app == null
            ? const Padding(
                padding: EdgeInsets.all(16),
                child: Notice('mobileAppsMissing'),
              )
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  SelectableText(app['url']),
                  const SizedBox(height: 12),
                  Text(context.tr('mobileAppsStatus_${app['status']}')),
                  Text(context.tr('mobileAppsAuth_${app['authType']}')),
                  if (app['error'] is String) Notice(app['error']),
                  if (app['revocation'] is String)
                    Notice('mobileAppsRevocation_${app['revocation']}'),
                  if (c.error != null) Notice(c.error!),
                  AppPendingCheck(
                    controller: c,
                    connectionId: widget.connectionId,
                  ),
                  if (c.busy) const LinearProgressIndicator(),
                  if (!c.scope.owner) const Notice('mobileAppsOwnerOnly'),
                  if (c.scope.owner && app['authType'] == 'oauth')
                    OAuthFlowPanel(
                      controller: c,
                      connectionId: widget.connectionId,
                    ),
                  if (c.scope.owner)
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        if (app['authType'] != 'oauth' ||
                            app['hasCredential'] == true)
                          OutlinedButton(
                            onPressed: c.canWriteConnection(widget.connectionId)
                                ? reconnect
                                : null,
                            child: Text(context.tr('mobileAppsReconnect')),
                          ),
                        OutlinedButton(
                          onPressed: c.canWriteConnection(widget.connectionId)
                              ? () => change(
                                  'disconnect',
                                  'mobileAppsDisconnectConfirm',
                                )
                              : null,
                          child: Text(
                            context.tr(
                              app['authType'] == 'oauth'
                                  ? 'mobileAppsRevoke'
                                  : 'mobileAppsDisconnect',
                            ),
                          ),
                        ),
                        TextButton(
                          onPressed: c.canWriteConnection(widget.connectionId)
                              ? () =>
                                    change('remove', 'mobileAppsRemoveConfirm')
                              : null,
                          child: Text(context.tr('mobileAppsRemove')),
                        ),
                      ],
                    ),
                  const Divider(height: 32),
                  Text(context.tr('mobileAppsToolsHelp')),
                  if (supportsToolAccess(app))
                    Text(context.tr('mobileAppsToolAccessHelp')),
                  OutlinedButton.icon(
                    onPressed: !c.busy && app['status'] == 'connected'
                        ? () => c.loadTools(widget.connectionId)
                        : null,
                    icon: const Icon(Icons.list_alt),
                    label: Text(context.tr('mobileAppsViewTools')),
                  ),
                  if (c.toolFeedback[widget.connectionId] case final feedback?)
                    Semantics(liveRegion: true, child: Notice(feedback)),
                  for (final tool in c.tools[widget.connectionId] ?? [])
                    _AppToolCard(
                      key: ValueKey(tool['name']),
                      tool: tool,
                      showAccess: supportsToolAccess(app),
                      owner: c.scope.owner,
                      onChanged: c.canManageTools(widget.connectionId)
                          ? (enabled) => c.setToolAccess(
                              widget.connectionId,
                              app['revision'],
                              tool,
                              enabled,
                            )
                          : null,
                    ),
                ],
              ),
      );
    },
  );
}

class _AppToolCard extends StatelessWidget {
  const _AppToolCard({
    super.key,
    required this.tool,
    required this.showAccess,
    required this.owner,
    required this.onChanged,
  });

  final Json tool;
  final bool showAccess, owner;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final access = showAccess ? toolAccess(tool) : null;
    final status = access?.enabled == true
        ? 'mobileAppsToolEnabled'
        : 'mobileAppsToolDisabled';
    const encoder = JsonEncoder.withIndent('  ');
    return Card(
      child: Column(
        children: [
          ExpansionTile(
            title: Text(tool['name']),
            subtitle: Text(tool['description']),
            childrenPadding: const EdgeInsets.all(16),
            children: [
              if (tool['annotations'] is Map)
                SelectableText(encoder.convert(tool['annotations'])),
              SelectableText(
                encoder.convert(tool['inputSchema']),
                style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              ),
            ],
          ),
          if (access != null)
            if (owner)
              SwitchListTile(
                title: Text(
                  context.tr('mobileAppsToolAllow'),
                  semanticsLabel:
                      '${tool['name']} · ${context.tr('mobileAppsToolAllow')}',
                ),
                subtitle: Text(context.tr(status)),
                value: access.enabled,
                onChanged: onChanged,
              )
            else
              ListTile(title: Text(context.tr(status))),
        ],
      ),
    );
  }
}

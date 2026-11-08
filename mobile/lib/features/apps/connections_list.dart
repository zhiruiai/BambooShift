import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'add_connection.dart';
import 'app_approval_rules_screen.dart';
import 'app_catalog.dart';
import 'app_catalog_screen.dart';
import 'apps_controller.dart';
import 'connection_details.dart';
import 'custom_mcp_target.dart';
import 'packaged_skills_screen.dart';
import 'pending_check.dart';
import 'private_skills_screen.dart';

class ConnectionsList extends StatefulWidget {
  const ConnectionsList({
    super.key,
    required this.scope,
    this.initialProviderId,
    this.initialCustomMcp,
  }) : assert(initialProviderId == null || initialCustomMcp == null);
  final WorkspaceController scope;
  final String? initialProviderId;
  final CustomMcpTarget? initialCustomMcp;
  @override
  State<ConnectionsList> createState() => _ConnectionsListState();
}

class _ConnectionsListState extends State<ConnectionsList>
    with WidgetsBindingObserver {
  late final AppsController controller;
  String? _reviewConnectionId;
  bool _reviewReady = false, _reviewBusy = false;
  String? _reviewError;
  bool get _isReview =>
      widget.initialProviderId != null || widget.initialCustomMcp != null;
  bool get _reviewAllowed =>
      controller.active &&
      widget.scope.owner &&
      (widget.initialCustomMcp == null || widget.scope.personalOwner);
  @override
  void initState() {
    super.initState();
    controller = AppsController(widget.scope);
    WidgetsBinding.instance.addObserver(this);
    unawaited(initialize());
  }

  Future<void> initialize() async {
    if (_isReview) {
      await _prepareReview();
    } else {
      await controller.initialize();
    }
  }

  Future<void> _prepareReview() async {
    if (_reviewBusy || controller.busy || !_reviewAllowed) {
      return;
    }
    setState(() {
      _reviewBusy = true;
      _reviewError = null;
    });
    try {
      final custom = widget.initialCustomMcp;
      final provider = custom == null
          ? (await loadAppProviders())
                .where((item) => item['id'] == widget.initialProviderId)
                .firstOrNull
          : null;
      if (!mounted || !_reviewAllowed) return;
      if (provider == null && custom == null) {
        _reviewError = 'mobileCollaborationAppUnavailable';
        return;
      }
      if (controller.ready) {
        await controller.refresh();
      } else {
        await controller.initialize();
      }
      if (!mounted ||
          !_reviewAllowed ||
          controller.error != null ||
          controller.blocked) {
        return;
      }
      final existing = custom == null
          ? findProviderConnection(provider!, controller.apps)
          : findExactMcpConnection(custom.url, controller.apps);
      if (existing == null && !controller.canAdd) return;
      _reviewConnectionId = existing?['id'] as String?;
      _reviewReady = true;
    } catch (_) {
      if (mounted) _reviewError = 'mobileCollaborationAppUnavailable';
    } finally {
      if (mounted) setState(() => _reviewBusy = false);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && (!_isReview || _reviewReady)) {
      unawaited(controller.refresh());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    controller.dispose();
    super.dispose();
  }

  Widget _review(BuildContext context) {
    if (_reviewReady && _reviewAllowed) {
      final id = _reviewConnectionId;
      return id == null
          ? AddConnection(
              controller: controller,
              initialProviderId: widget.initialProviderId,
              initialCustomMcp: widget.initialCustomMcp,
              onConnected: (id) => setState(() => _reviewConnectionId = id),
            )
          : ConnectionDetails(controller: controller, connectionId: id);
    }
    final allowed = _reviewAllowed;
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('mobileAppsTitle'))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (!allowed)
            const Notice('scopeChanged')
          else ...[
            if (_reviewBusy || controller.busy) const LinearProgressIndicator(),
            if ((_reviewError ?? controller.error) case final error?)
              Notice(error),
            AppPendingCheck(controller: controller),
            if (!_reviewBusy && !controller.busy)
              TextButton(
                onPressed: _prepareReview,
                child: Text(context.tr('mobileCollaborationAppRetry')),
              ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => _isReview ? _review(context) : _list(context),
  );

  Widget _list(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(context.tr('mobileAppsTitle')),
      actions: [
        IconButton(
          tooltip: context.tr('mobileAppsRefresh'),
          onPressed: controller.active && !controller.busy
              ? controller.refresh
              : null,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: !controller.active
        ? const Notice('scopeChanged')
        : ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(context.tr('mobileAppsIntro')),
              if (!widget.scope.owner) const Notice('mobileAppsOwnerOnly'),
              if (controller.error != null) Notice(controller.error!),
              if (controller.hasPending) const Notice('mobileAppsUnknown'),
              AppPendingCheck(controller: controller),
              if (controller.busy) const LinearProgressIndicator(),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.apps),
                title: Text(context.tr('mobileAppsDirectory')),
                subtitle: Text(context.tr('mobileAppsDirectoryIntro')),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => AppCatalogScreen(controller: controller),
                  ),
                ),
              ),
              if (widget.scope.personalOwner) ...[
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.verified_user_outlined),
                  title: Text(context.tr('mobileAppsRulesTitle')),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          AppApprovalRulesScreen(scope: widget.scope),
                    ),
                  ),
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.menu_book_outlined),
                  title: Text(context.tr('mobileAppsPrivateSkillsTitle')),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => PrivateSkillsScreen(scope: widget.scope),
                    ),
                  ),
                ),
              ],
              if (widget.scope.owner)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: FilledButton.icon(
                    onPressed: controller.canAdd
                        ? () => Navigator.push(
                            context,
                            MaterialPageRoute<void>(
                              builder: (_) =>
                                  AddConnection(controller: controller),
                            ),
                          )
                        : null,
                    icon: const Icon(Icons.add),
                    label: Text(context.tr('mobileAppsAdd')),
                  ),
                ),
              if (controller.ready &&
                  controller.apps.isEmpty &&
                  !controller.busy)
                const Notice('mobileAppsEmpty'),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.auto_awesome_outlined),
                title: Text(context.tr('mobileAppsPackagedSkills')),
                subtitle: Text(context.tr('mobileAppsPackagedIntro')),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.push<void>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => PackagedSkillsScreen(scope: widget.scope),
                  ),
                ),
              ),
              for (final app in controller.apps)
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.extension_outlined),
                    title: Text(app['name']),
                    subtitle: Text(
                      '${context.tr('mobileAppsStatus_${app['status']}')} · ${app['toolCount']} ${context.tr('mobileAppsTools')}',
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute<void>(
                        builder: (_) => ConnectionDetails(
                          controller: controller,
                          connectionId: app['id'],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
  );
}

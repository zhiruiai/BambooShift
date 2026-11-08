import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../apps/app_catalog.dart';
import '../apps/apps_data.dart';
import '../apps/connections_list.dart';
import '../apps/custom_mcp_target.dart';
import 'proposal_access.dart';
import 'team_data.dart';

class AppConnectionProposalCard extends StatefulWidget {
  const AppConnectionProposalCard({
    super.key,
    required this.scope,
    required this.message,
  });

  final WorkspaceController scope;
  final Json message;

  @override
  State<AppConnectionProposalCard> createState() =>
      _AppConnectionProposalCardState();
}

class _AppConnectionProposalCardState extends State<AppConnectionProposalCard> {
  late final _providers = loadAppProviders();
  late final _access = ProposalAccess(widget.scope);
  bool _busy = false;
  bool _failed = false;
  int _revision = 0;

  bool get _allowed {
    final scope = widget.scope;
    final message = widget.message;
    final proposal = appProposal(message);
    if (!_access.active ||
        !localProposalBot(scope, message) ||
        proposal?['requester']['userId'] != scope.userId) {
      return false;
    }
    if (customMcpTarget(proposal) == null) return true;
    return scope.personalOwner &&
        customMcpProposalChat(
          scope.find('conversations', message['conversationId'] as String),
          message['agentId'],
        );
  }

  @override
  void didUpdateWidget(AppConnectionProposalCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (canonical(oldWidget.message) != canonical(widget.message)) {
      _revision++;
      _failed = false;
    }
  }

  @override
  void dispose() {
    _access.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    if (_busy || !_allowed) return;
    final revision = _revision;
    final message = copyJson(widget.message);
    setState(() {
      _busy = true;
      _failed = false;
    });
    try {
      final proposal = await _access.app(message);
      if (!mounted || !_allowed || revision != _revision) return;
      await Navigator.push<void>(
        context,
        MaterialPageRoute(
          builder: (_) => ConnectionsList(
            scope: widget.scope,
            initialProviderId: proposal['providerId'] as String?,
            initialCustomMcp: customMcpTarget(proposal),
          ),
        ),
      );
      if (mounted && widget.scope.active) await widget.scope.refresh();
    } catch (_) {
      if (mounted && widget.scope.active && revision == _revision) {
        _failed = true;
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _action(Json? existing) => switch (existing?['status']) {
    'connected' => 'mobileCollaborationAppManage',
    _ when existing?['authType'] == 'oauth' =>
      'mobileCollaborationAppAuthorize',
    _ when existing != null => 'mobileCollaborationAppReview',
    _ => 'mobileCollaborationAppOpen',
  };

  @override
  Widget build(BuildContext context) {
    final proposal = appProposal(widget.message);
    if (proposal == null) return const SizedBox.shrink();
    final custom = customMcpTarget(proposal);
    return FutureBuilder<List<Json>>(
      future: custom == null ? _providers : null,
      builder: (context, snapshot) {
        final provider = snapshot.data
            ?.where((item) => item['id'] == proposal['providerId'])
            .firstOrNull;
        if (provider == null && custom == null) {
          return snapshot.connectionState == ConnectionState.done
              ? const Notice('mobileCollaborationAppUnavailable')
              : const LinearProgressIndicator();
        }
        return ListenableBuilder(
          listenable: Listenable.merge([widget.scope, widget.scope.session]),
          builder: (context, _) {
            if (!widget.scope.active) return const SizedBox.shrink();
            final apps = widget.scope
                .items('apps')
                .where(
                  (app) =>
                      app['url'] is String && appStates.contains(app['status']),
                )
                .toList();
            final existing = custom == null
                ? findProviderConnection(provider!, apps)
                : findExactMcpConnection(custom.url, apps);
            final name = custom?.name ?? provider!['name'] as String;
            final title = context
                .tr('mobileCollaborationAppTitle')
                .replaceAll('{provider}', name);
            final status = context.tr(
              existing == null
                  ? 'mobileAppsNotConfigured'
                  : 'mobileAppsStatus_${existing['status']}',
            );
            return Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Semantics(
                      container: true,
                      header: true,
                      label: title,
                      excludeSemantics: true,
                      child: Row(
                        children: [
                          CircleAvatar(
                            radius: 18,
                            child: custom == null
                                ? Text(provider!['mark'] as String)
                                : const Icon(Icons.extension_outlined),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              title,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),
                    if (custom != null) ...[
                      Text(context.tr('mobileCollaborationAppCustom')),
                      SelectableText(custom.url),
                      const SizedBox(height: 8),
                    ],
                    SelectableText(proposal['reason'] as String),
                    const SizedBox(height: 8),
                    Semantics(
                      container: true,
                      liveRegion: true,
                      label: status,
                      excludeSemantics: true,
                      child: Text(
                        status,
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    ),
                    if (_allowed) ...[
                      const SizedBox(height: 6),
                      Text(
                        context.tr(
                          custom == null
                              ? 'mobileCollaborationAppHint'
                              : 'mobileCollaborationAppCustomHint',
                        ),
                      ),
                      if (_failed)
                        const Notice('mobileCollaborationAppUnavailable'),
                      if (_busy) const LinearProgressIndicator(),
                      OutlinedButton.icon(
                        onPressed: _busy ? null : _open,
                        icon: const Icon(Icons.link_outlined),
                        label: Text(
                          context.tr(
                            _failed
                                ? 'mobileCollaborationAppRetry'
                                : _action(existing),
                          ),
                        ),
                      ),
                    ] else
                      Text(context.tr('mobileCollaborationAppOwner')),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }
}

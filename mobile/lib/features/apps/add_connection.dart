import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'app_catalog.dart';
import 'apps_controller.dart';
import 'connection_details.dart';
import 'custom_mcp_target.dart';
import 'pending_check.dart';
import 'mcp_import_preview.dart';
import 'remote_mcp_import.dart';
import 'remote_mcp_import_view.dart';

class AddConnection extends StatefulWidget {
  const AddConnection({
    super.key,
    required this.controller,
    this.initialProviderId,
    this.initialCustomMcp,
    this.onConnected,
  }) : assert(
         initialCustomMcp == null ||
             (initialProviderId == null && onConnected != null),
       );
  final AppsController controller;
  final String? initialProviderId;
  final CustomMcpTarget? initialCustomMcp;
  final ValueChanged<String>? onConnected;
  @override
  State<AddConnection> createState() => _AddConnectionState();
}

class _AddConnectionState extends State<AddConnection> {
  final name = TextEditingController(),
      url = TextEditingController(),
      token = TextEditingController();
  String auth = 'oauth';
  bool shared = false;
  bool _submitting = false, _catalogError = false;
  List<Json> providers = [];
  Json? _reviewedProvider;
  bool get _review => widget.onConnected != null;
  bool get _catalogReview => _review && widget.initialCustomMcp == null;
  bool get _canAdd =>
      widget.controller.canAdd &&
      (widget.initialCustomMcp == null ||
          widget.controller.scope.personalOwner);
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(scopeChanged);
    final custom = widget.initialCustomMcp;
    if (custom == null) {
      loadProviders();
    } else {
      name.text = custom.name.length <= 80
          ? custom.name
          : custom.name.substring(0, 80);
      url.text = custom.url;
      auth = 'none';
    }
  }

  void scopeChanged() {
    final scope = widget.controller.scope;
    if (!widget.controller.active ||
        !scope.owner ||
        (widget.initialCustomMcp != null && !scope.personalOwner)) {
      token.clear();
      shared = false;
    }
  }

  Future<void> loadProviders() async {
    List<Json> values;
    try {
      values = await loadAppProviders();
    } catch (_) {
      if (mounted) setState(() => _catalogError = true);
      return;
    }
    if (mounted) {
      setState(() {
        providers = values;
        if (widget.controller.active && widget.controller.scope.owner) {
          for (final provider in providers) {
            if (provider['id'] == widget.initialProviderId) {
              _reviewedProvider = provider;
              name.text = provider['name'];
              url.text = provider['url'];
              auth = provider['authType'];
              token.clear();
              shared = false;
              break;
            }
          }
        }
      });
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(scopeChanged);
    name.dispose();
    url.dispose();
    token.dispose();
    super.dispose();
  }

  Future<void> save() async {
    final controller = widget.controller;
    if (_submitting || !_canAdd || !shared) return;
    setState(() => _submitting = true);
    try {
      final custom = widget.initialCustomMcp;
      if (_review) {
        final provider = _reviewedProvider;
        if (provider == null && custom == null) return;
        await controller.refresh();
        if (!mounted || !_canAdd || !shared || controller.error != null) return;
        final existing = custom == null
            ? findProviderConnection(provider!, controller.apps)
            : findExactMcpConnection(custom.url, controller.apps);
        if (existing != null) {
          token.clear();
          widget.onConnected!(existing['id'] as String);
          return;
        }
      }
      final result = await controller.add({
        'name': name.text,
        'url': custom?.url ?? url.text,
        'authType': auth,
        'shared': shared,
        'token': token.text,
      }, reviewedEndpoint: custom?.url);
      if (!mounted) return;
      token.clear();
      if (!controller.active || result is! Json) return;
      final id = result['id'] as String;
      final onConnected = widget.onConnected;
      if (onConnected != null) {
        onConnected(id);
      } else {
        await Navigator.pushReplacement(
          context,
          MaterialPageRoute<void>(
            builder: (_) =>
                ConnectionDetails(controller: controller, connectionId: id),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void applyImported(RemoteMcpCandidate candidate) {
    if (!_canAdd || _submitting || _review) return;
    final provider = providers
        .where((value) => value['url'] == candidate.url)
        .firstOrNull;
    setState(() {
      name.text = candidate.name;
      url.text = candidate.url;
      auth = provider?['authType'] as String? ?? 'none';
      token.clear();
      shared = false;
    });
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final enabled =
          _canAdd &&
          !_submitting &&
          (!_catalogReview || _reviewedProvider != null);
      return Scaffold(
        appBar: AppBar(title: Text(context.tr('mobileAppsAdd'))),
        body: !controller.active
            ? const Notice('scopeChanged')
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Text(
                    context.tr(
                      widget.initialCustomMcp != null
                          ? 'mobileCollaborationAppCustomHint'
                          : _review
                          ? 'mobileCollaborationAppHint'
                          : 'mobileAppsCatalogHelp',
                    ),
                  ),
                  if (_catalogError)
                    const Notice('mobileCollaborationAppUnavailable'),
                  if (!_review)
                    Wrap(
                      spacing: 8,
                      children: [
                        for (final provider in providers)
                          ActionChip(
                            label: Text(provider['name']),
                            onPressed: enabled
                                ? () => setState(() {
                                    name.text = provider['name'];
                                    url.text = provider['url'];
                                    auth = provider['authType'];
                                    token.clear();
                                    shared = false;
                                  })
                                : null,
                          ),
                      ],
                    ),
                  const SizedBox(height: 16),
                  if (!_review && controller.scope.owner) ...[
                    RemoteMcpImportView(
                      enabled: enabled,
                      hasDraft: () =>
                          name.text.isNotEmpty ||
                          url.text.isNotEmpty ||
                          token.text.isNotEmpty ||
                          shared ||
                          auth != 'oauth',
                      draftVersion: () => (
                        name: name.text,
                        url: url.text,
                        token: token.text,
                        auth: auth,
                        shared: shared,
                      ),
                      onApply: applyImported,
                      onInspect: (draft) =>
                          previewRemoteMcpImport(controller, draft),
                    ),
                    const SizedBox(height: 16),
                  ],
                  TextField(
                    controller: name,
                    enabled: enabled,
                    readOnly: _catalogReview,
                    maxLength: 80,
                    onChanged: enabled && widget.initialCustomMcp != null
                        ? (_) => setState(() => shared = false)
                        : null,
                    decoration: InputDecoration(
                      labelText: context.tr('mobileAppsName'),
                    ),
                  ),
                  TextField(
                    controller: url,
                    enabled: enabled,
                    readOnly: _review,
                    maxLines: widget.initialCustomMcp == null ? 1 : 4,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    onChanged: enabled && !_review
                        ? (_) => setState(() {
                            token.clear();
                            shared = false;
                          })
                        : null,
                    decoration: InputDecoration(
                      labelText: context.tr('mobileAppsUrl'),
                    ),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: auth,
                    key: ValueKey(auth),
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: context.tr('mobileAppsAuth'),
                    ),
                    items: [
                      for (final type in ['oauth', 'bearer', 'none'])
                        DropdownMenuItem(
                          value: type,
                          child: Text(
                            context.tr('mobileAppsAuth_$type'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: enabled && !_catalogReview
                        ? (value) => setState(() {
                            auth = value!;
                            token.clear();
                            if (widget.initialCustomMcp != null) shared = false;
                          })
                        : null,
                  ),
                  if (auth == 'bearer')
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: TextField(
                        controller: token,
                        enabled: enabled,
                        obscureText: true,
                        enableSuggestions: false,
                        autocorrect: false,
                        onChanged: enabled && widget.initialCustomMcp != null
                            ? (_) => setState(() => shared = false)
                            : null,
                        decoration: InputDecoration(
                          labelText: context.tr('mobileAppsToken'),
                        ),
                      ),
                    ),
                  CheckboxListTile(
                    value: shared,
                    contentPadding: EdgeInsets.zero,
                    title: Text(context.tr('mobileAppsShareConfirm')),
                    onChanged: enabled
                        ? (value) => setState(() => shared = value ?? false)
                        : null,
                  ),
                  if (controller.error != null) Notice(controller.error!),
                  AppPendingCheck(controller: controller),
                  if (controller.busy) const LinearProgressIndicator(),
                  FilledButton(
                    onPressed: enabled && shared ? save : null,
                    child: Text(context.tr('mobileAppsConnect')),
                  ),
                ],
              ),
      );
    },
  );
}

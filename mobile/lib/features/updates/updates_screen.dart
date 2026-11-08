import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'updates_controller.dart';

class UpdatesScreen extends StatefulWidget {
  const UpdatesScreen({super.key, required this.scope, this.openRelease});
  final WorkspaceController scope;
  final Future<bool> Function(Uri)? openRelease;
  @override
  State<UpdatesScreen> createState() => _UpdatesScreenState();
}

class _UpdatesScreenState extends State<UpdatesScreen> {
  late final model = UpdatesController(widget.scope)..read();
  String? openError;
  @override
  void dispose() {
    model.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    final uri = model.releaseUri;
    if (uri == null) return;
    try {
      final opened =
          await (widget.openRelease?.call(uri) ??
              launchUrl(uri, mode: LaunchMode.externalApplication));
      if (mounted && model.active) {
        setState(() => openError = opened ? null : 'mobileUpdatesOpenFailed');
      }
    } catch (_) {
      if (mounted && model.active) {
        setState(() => openError = 'mobileUpdatesOpenFailed');
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: model,
    builder: (context, _) {
      final data = model.data, release = model.data?['release'];
      return Scaffold(
        appBar: AppBar(
          title: Text(context.tr('mobileUpdatesTitle')),
          actions: [
            IconButton(
              tooltip: context.tr('refresh'),
              onPressed: model.busy ? null : model.read,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            const Notice('mobileUpdatesScope'),
            if (model.busy) const LinearProgressIndicator(),
            if (model.error != null) Notice(model.error!),
            if (openError != null) Notice(openError!),
            if (data != null) ...[
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        context.tr('mobileUpdatesServiceVersion'),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      SelectableText(data['serviceVersion'] as String),
                      const SizedBox(height: 16),
                      Text(context.tr('mobileUpdatesStatus_${data['status']}')),
                      if (data['reason'] != null)
                        Text(
                          context.tr('mobileUpdatesReason_${data['reason']}'),
                        ),
                      if (data['repository'] != null) ...[
                        const SizedBox(height: 12),
                        Text(data['repository'] as String),
                      ],
                      if (data['checkedAt'] != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          '${context.tr('mobileUpdatesCheckedAt')}: ${DateTime.parse(data['checkedAt'] as String).toUtc().toIso8601String()}',
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: model.canCheck
                    ? () => model.read(check: true)
                    : null,
                icon: const Icon(Icons.refresh),
                label: Text(context.tr('mobileUpdatesCheck')),
              ),
              if (release != null)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          release['name'] as String,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        Text(release['tag'] as String),
                        const SizedBox(height: 12),
                        SelectableText(release['notes'] as String),
                        const SizedBox(height: 12),
                        OutlinedButton.icon(
                          onPressed: model.active ? _open : null,
                          icon: const Icon(Icons.open_in_new),
                          label: Text(context.tr('mobileUpdatesOpen')),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ],
        ),
      );
    },
  );
}

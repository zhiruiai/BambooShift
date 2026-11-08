import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'file_export_controller.dart';
import 'website_preview_content.dart';
import 'website_preview_platform.dart';
import 'website_project_client.dart';
import 'website_project_data.dart';
import 'website_project_source.dart';
import 'website_share_screen.dart';

String websiteFileCount(BuildContext context, WebsiteProject project) => context
    .tr(
      project.fileCount == 1
          ? 'mobileWebsiteOneFile'
          : 'mobileWebsiteFileCount',
    )
    .replaceFirst('{count}', '${project.fileCount}');

enum _Mode { preview, source }

class WebsiteProjectScreen extends StatefulWidget {
  const WebsiteProjectScreen({
    super.key,
    required this.client,
    this.onDiscuss,
    this.previewBuilder,
    this.exportDestination,
  });
  final WebsiteProjectClient client;
  final VoidCallback? onDiscuss;
  final WebsitePreviewBuilder? previewBuilder;
  final FileExportDestination? exportDestination;

  @override
  State<WebsiteProjectScreen> createState() => _WebsiteProjectScreenState();
}

class _WebsiteProjectScreenState extends State<WebsiteProjectScreen> {
  WebsiteProjectClient get client => widget.client;
  late final destination =
      widget.exportDestination ?? websiteArchiveDestination();
  ByteReadCancellation? _reading, _exporting;
  WebsitePreviewContent? content;
  String? readError, exportFeedback;
  bool loading = true;
  _Mode mode = _Mode.preview;

  @override
  void initState() {
    super.initState();
    client.scope.addListener(_scopeChanged);
    client.scope.session.addListener(_scopeChanged);
    unawaited(load());
  }

  void _scopeChanged() {
    if (!mounted) return;
    if (!client.active) {
      _reading?.cancel();
      _exporting?.cancel();
      content = null;
      exportFeedback = null;
    }
    setState(() {});
  }

  Future<void> load() async {
    if (!client.active) return;
    _reading?.cancel();
    final cancellation = _reading = ByteReadCancellation();
    setState(() {
      loading = true;
      readError = null;
      content = null;
    });
    try {
      final files = await client.load(cancellation);
      if (!mounted || _reading != cancellation || !client.active) return;
      setState(() => content = WebsitePreviewContent(client.project, files));
    } catch (_) {
      if (mounted && _reading == cancellation && client.active) {
        setState(() => readError = 'mobileWebsiteLoadFailed');
      }
    } finally {
      if (mounted && _reading == cancellation) setState(() => loading = false);
    }
  }

  Future<void> export(BuildContext anchor) async {
    if (!client.active || _exporting != null || !destination.supported) return;
    final box = anchor.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return;
    final origin = box.localToGlobal(Offset.zero) & box.size;
    final cancellation = _exporting = ByteReadCancellation();
    setState(() => exportFeedback = null);
    void guard() {
      if (!mounted || !client.active || cancellation.cancelled) {
        throw const ApiException('STALE_SCOPE', 'scopeChanged');
      }
    }

    try {
      final bytes = await client.download(cancellation);
      guard();
      final result = await destination.export(
        bytes,
        client.archiveName,
        origin,
        authorize: () => client.authorize(cancellation),
        guard: guard,
      );
      guard();
      exportFeedback = switch (result) {
        FileExportResult.selected => 'mobileFilesExportSelected',
        FileExportResult.dismissed => 'mobileFilesExportDismissed',
        FileExportResult.saved => 'mobileFilesExportSaved',
        FileExportResult.unknown => 'mobileWebsiteExportRequested',
      };
    } catch (_) {
      if (mounted && client.active) {
        exportFeedback = 'mobileWebsiteExportFailed';
      }
    } finally {
      if (mounted) setState(() => _exporting = null);
    }
  }

  Json? get _latest {
    final messages = client.scope
        .items('messages')
        .where(
          (item) =>
              item['conversationId'] == client.message['conversationId'] &&
              websiteProjectFor(item)?.projectKey == client.project.projectKey,
        );
    final message = messages.lastOrNull;
    return message != null &&
            websiteProjectFor(message)?.id != client.project.id
        ? message
        : null;
  }

  void _openLatest(Json message) {
    final next = WebsiteProjectClient(client.scope, message);
    if (!next.active) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => WebsiteProjectScreen(
          client: next,
          onDiscuss: widget.onDiscuss,
          previewBuilder: widget.previewBuilder,
          exportDestination: widget.exportDestination,
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    if (!client.active) {
      return const Center(child: Notice('mobileWebsiteUnavailable'));
    }
    if (loading) return const Center(child: CircularProgressIndicator());
    if (readError case final String error) {
      return Center(
        child: Notice(
          error,
          action: 'retry',
          onAction: () => unawaited(load()),
        ),
      );
    }
    final data = content;
    if (data == null) {
      return const Center(child: Notice('mobileWebsiteUnavailable'));
    }
    return mode == _Mode.source
        ? WebsiteProjectSource(content: data)
        : (widget.previewBuilder ?? platformWebsitePreview)(context, data);
  }

  @override
  Widget build(BuildContext context) {
    final project = client.project;
    final latest = client.active ? _latest : null;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          project.title,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
        ),
        leading: CloseButton(onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          IconButton(
            tooltip: context.tr('mobileWebsiteShare'),
            onPressed: client.active && content != null
                ? () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => WebsiteShareScreen(project: client),
                    ),
                  )
                : null,
            icon: const Icon(Icons.share_outlined),
          ),
          if (widget.onDiscuss case final discuss?)
            IconButton(
              tooltip: context.tr('mobileWebsiteDiscuss'),
              onPressed: client.active
                  ? () {
                      Navigator.pop(context);
                      discuss();
                    }
                  : null,
              icon: const Icon(Icons.chat_bubble_outline),
            ),
          Builder(
            builder: (anchor) => IconButton(
              tooltip: context.tr(
                destination.supported
                    ? 'mobileWebsiteDownload'
                    : 'mobileFilesExportUnavailable',
              ),
              onPressed:
                  client.active && destination.supported && _exporting == null
                  ? () => unawaited(export(anchor))
                  : null,
              icon: _exporting != null
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.download_outlined),
            ),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            if (client.active)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                child: Wrap(
                  alignment: WrapAlignment.center,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 12,
                  runSpacing: 4,
                  children: [
                    SegmentedButton<_Mode>(
                      showSelectedIcon: false,
                      style: const ButtonStyle(
                        textStyle: WidgetStatePropertyAll(
                          TextStyle(fontSize: 13),
                        ),
                      ),
                      segments: [
                        ButtonSegment(
                          value: _Mode.preview,
                          label: Text(context.tr('mobileWebsitePreview')),
                        ),
                        ButtonSegment(
                          value: _Mode.source,
                          label: Text(context.tr('mobileWebsiteSource')),
                        ),
                      ],
                      selected: {mode},
                      onSelectionChanged: (selection) =>
                          setState(() => mode = selection.single),
                    ),
                    Text(
                      websiteFileCount(context, project),
                      style: const TextStyle(fontSize: 12),
                    ),
                    if (latest != null)
                      TextButton(
                        onPressed: () => _openLatest(latest),
                        child: Text(
                          context.tr('mobileWebsiteLatest'),
                          style: const TextStyle(fontSize: 13),
                        ),
                      ),
                  ],
                ),
              ),
            if (exportFeedback case final String message) Notice(message),
            const Divider(height: 1),
            Expanded(child: _body(context)),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    client.scope.removeListener(_scopeChanged);
    client.scope.session.removeListener(_scopeChanged);
    _reading?.cancel();
    _exporting?.cancel();
    super.dispose();
  }
}

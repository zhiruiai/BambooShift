import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../files/file_export_button.dart';
import '../files/file_export_controller.dart';
import 'chat_markdown.dart';
import 'file_preview_data.dart';

class FilePreviewScreen extends StatefulWidget {
  const FilePreviewScreen({
    super.key,
    required this.scope,
    required this.file,
    this.conversationId,
    this.exportDestination,
  });
  final WorkspaceController scope;
  final ChatFile file;
  final String? conversationId;
  final FileExportDestination? exportDestination;
  @override
  State<FilePreviewScreen> createState() => _FilePreviewScreenState();
}

class _FilePreviewScreenState extends State<FilePreviewScreen> {
  ByteReadCancellation? cancellation;
  String? content, error;
  ui.Image? image;
  bool busy = false;
  int generation = 0;
  String? exportConversationId;
  @override
  void initState() {
    super.initState();
    final registered = widget.scope.find('files', widget.file.id);
    exportConversationId =
        widget.conversationId ??
        (registered?['conversationId'] is String
            ? registered!['conversationId'] as String
            : null);
    widget.scope.addListener(_scopeChanged);
    unawaited(load());
  }

  bool get valid =>
      mounted &&
      widget.scope.active &&
      widget.scope.find('files', widget.file.id) != null;
  void _scopeChanged() {
    if (!valid) {
      cancellation?.cancel();
      generation++;
      final old = image;
      image = null;
      old?.dispose();
      if (mounted) {
        setState(() {
          content = null;
          error = 'mobileChatFileUnavailable';
          busy = false;
        });
      }
    }
  }

  Future<void> load() async {
    if (!valid) return;
    cancellation?.cancel();
    final cancel = cancellation = ByteReadCancellation();
    final epoch = ++generation;
    final old = image;
    image = null;
    old?.dispose();
    setState(() {
      busy = true;
      error = null;
      content = null;
    });
    void check() {
      if (!valid || epoch != generation || cancel.cancelled) {
        throw const ApiException('STALE_SCOPE', 'scopeChanged');
      }
    }

    try {
      if (!widget.file.supported) {
        throw const ApiException(
          'UNSUPPORTED_FILE',
          'mobileChatFileUnsupported',
        );
      }
      if (widget.file.size > 2 * 1024 * 1024) {
        throw const ApiException('FILE_TOO_LARGE', 'mobileChatFileTooLarge');
      }
      final data = await widget.scope.session.api.readWorkspaceFile(
        widget.scope.workspaceId,
        widget.file.id,
        expectedUser: widget.scope.userId,
        isCurrent: () => valid && epoch == generation,
        cancellation: cancel,
      );
      check();
      if (widget.file.image) {
        final next = await previewImage(data, check);
        try {
          check();
        } catch (_) {
          next.dispose();
          rethrow;
        }
        image = next;
      } else {
        content = previewText(data, widget.file);
      }
      check();
    } catch (e) {
      if (valid && epoch == generation) {
        error = e is ApiException ? e.message : 'mobileChatFileFailed';
      }
    } finally {
      if (valid && epoch == generation) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    generation++;
    cancellation?.cancel();
    widget.scope.removeListener(_scopeChanged);
    image?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.file.name),
      actions: [
        FileExportButton(
          scope: widget.scope,
          conversationId: exportConversationId,
          file: widget.file,
          destination: widget.exportDestination,
        ),
        IconButton(
          tooltip: context.tr('refresh'),
          onPressed: busy || !valid ? null : load,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: !valid
        ? const Notice('mobileChatFileUnavailable')
        : busy
        ? const Center(child: CircularProgressIndicator())
        : error != null
        ? Padding(
            padding: const EdgeInsets.all(20),
            child: Notice(error!, action: 'retry', onAction: load),
          )
        : image != null
        ? InteractiveViewer(
            minScale: .5,
            maxScale: 4,
            child: Center(
              child: RawImage(image: image, fit: BoxFit.contain),
            ),
          )
        : SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (widget.file.html) const Notice('mobileChatHtmlSourceOnly'),
                if (widget.file.markdown)
                  ChatMarkdown(text: content ?? '', canOpenLink: () => valid)
                else
                  SelectableText(
                    content ?? '',
                    style: const TextStyle(fontSize: 14, height: 1.5),
                  ),
              ],
            ),
          ),
  );
}

import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:web/web.dart' as web;

import '../../core/byte_read.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'file_export_controller.dart';
import 'website_preview_content.dart';

FileExportDestination websiteArchiveDestination() => _BrowserWebsiteArchive();

class _BrowserWebsiteArchive implements FileExportDestination {
  @override
  bool get supported => true;

  @override
  Future<FileExportResult> export(
    FileBytes data,
    String name,
    Rect origin, {
    required Future<void> Function() authorize,
    required void Function() guard,
  }) async {
    await authorize();
    guard();
    final url = web.URL.createObjectURL(
      web.Blob(
        [data.bytes.toJS].toJS,
        web.BlobPropertyBag(type: data.mimeType),
      ),
    );
    final link = web.HTMLAnchorElement()
      ..href = url
      ..download = name;
    try {
      web.document.body?.append(link);
      link.click();
    } finally {
      link.remove();
      Timer(const Duration(seconds: 30), () => web.URL.revokeObjectURL(url));
    }
    return FileExportResult.unknown;
  }
}

Widget platformWebsitePreview(
  BuildContext context,
  WebsitePreviewContent data,
) => _WebWebsitePreview(data);

class _WebWebsitePreview extends StatefulWidget {
  const _WebWebsitePreview(this.data);
  final WebsitePreviewContent data;

  @override
  State<_WebWebsitePreview> createState() => _WebWebsitePreviewState();
}

class _WebWebsitePreviewState extends State<_WebWebsitePreview> {
  late final _shell = rootBundle.loadString(websiteRendererAsset);

  @override
  Widget build(BuildContext context) => FutureBuilder(
    future: _shell,
    builder: (context, snapshot) {
      if (snapshot.hasError) {
        return const Center(child: Notice('mobileWebsiteRenderFailed'));
      }
      final shell = snapshot.data;
      if (shell == null) {
        return const Center(child: CircularProgressIndicator());
      }
      final payload = jsonEncode(
        widget.data.encode(context),
      ).replaceAll('<', r'\u003c');
      final boundary = shell.lastIndexOf('</body>');
      if (boundary < 0) {
        return const Center(child: Notice('mobileWebsiteRenderFailed'));
      }
      final document =
          '${shell.substring(0, boundary)}'
          '<script>openbotAppendProjectPreview($payload);openbotRenderProjectPreview();</script>'
          '${shell.substring(boundary)}';
      return HtmlElementView.fromTagName(
        tagName: 'iframe',
        onElementCreated: (element) {
          final frame = element as web.HTMLIFrameElement;
          frame.title = context.tr('mobileWebsiteDocument');
          frame.referrerPolicy = 'no-referrer';
          frame.sandbox.add('allow-scripts');
          frame.sandbox.add('allow-pointer-lock');
          frame.style
            ..width = '100%'
            ..height = '100%'
            ..border = '0';
          frame.srcdoc = document.toJS;
        },
      );
    },
  );
}

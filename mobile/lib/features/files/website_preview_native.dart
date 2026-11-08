import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../widgets/common.dart';
import 'file_export_controller.dart';
import 'file_export_platform.dart';
import 'website_preview_content.dart';

FileExportDestination websiteArchiveDestination() => NativeFileExport();

Widget platformWebsitePreview(
  BuildContext context,
  WebsitePreviewContent data,
) {
  if (!const [
    TargetPlatform.android,
    TargetPlatform.iOS,
    TargetPlatform.macOS,
  ].contains(defaultTargetPlatform)) {
    return const Notice('mobileWebsitePlatformUnavailable');
  }
  return _NativeWebsitePreview(data);
}

class _NativeWebsitePreview extends StatefulWidget {
  const _NativeWebsitePreview(this.data);
  final WebsitePreviewContent data;

  @override
  State<_NativeWebsitePreview> createState() => _NativeWebsitePreviewState();
}

class _NativeWebsitePreviewState extends State<_NativeWebsitePreview> {
  WebViewController? controller;
  bool loading = true, failed = false, sent = false;

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  Future<void> _open() async {
    try {
      final view = controller = WebViewController();
      await view.setJavaScriptMode(JavaScriptMode.unrestricted);
      await view.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            return request.url == 'about:srcdoc' ||
                    request.url == 'about:blank' ||
                    (uri?.scheme == 'file' &&
                        uri!.path.endsWith('/$websiteRendererAsset'))
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
          onPageFinished: (_) => unawaited(_render(view)),
          onWebResourceError: (error) {
            if (error.isForMainFrame == true) _fail();
          },
        ),
      );
      if (!mounted) return;
      setState(() {});
      await view.loadFlutterAsset(websiteRendererAsset);
    } catch (_) {
      _fail();
    }
  }

  Future<void> _render(WebViewController view) async {
    if (!mounted || sent || failed) return;
    sent = true;
    try {
      final payload = widget.data.encode(context);
      // Bounded chunks stay below native platform channel message limits.
      const size = 64 * 1024;
      for (var start = 0; start < payload.length; start += size) {
        if (!mounted) return;
        final chunk = jsonEncode(
          payload.substring(start, min(start + size, payload.length)),
        );
        await view.runJavaScript('openbotAppendProjectPreview($chunk)');
      }
      if (!mounted) return;
      await view.runJavaScript('openbotRenderProjectPreview()');
      if (mounted) setState(() => loading = false);
    } catch (_) {
      _fail();
    }
  }

  void _fail() {
    if (mounted) setState(() => failed = true);
  }

  @override
  Widget build(BuildContext context) => failed
      ? const Center(child: Notice('mobileWebsiteRenderFailed'))
      : Stack(
          fit: StackFit.expand,
          children: [
            if (controller case final view?) WebViewWidget(controller: view),
            if (loading) const Center(child: CircularProgressIndicator()),
          ],
        );
}

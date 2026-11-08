import 'dart:convert';

import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import 'website_project_data.dart';

const websiteRendererAsset = 'assets/website_preview/renderer.html';

typedef WebsitePreviewBuilder =
    Widget Function(BuildContext, WebsitePreviewContent);

class WebsitePreviewContent {
  const WebsitePreviewContent(this.project, this.files);
  final WebsiteProject project;
  final List<WebsiteProjectFile> files;

  String encode(BuildContext context) => jsonEncode({
    'entry': project.entry,
    'documentTitle': context.tr('mobileWebsiteDocument'),
    'homeLabel': context.tr('mobileWebsiteHome'),
    'scriptError': context.tr('mobileWebsiteScriptError'),
    'partial': context.tr('mobileWebsitePartial'),
    'loadFailed': context.tr('mobileWebsiteRenderFailed'),
    'files': files
        .map(
          (file) => {
            'path': file.asset.path,
            'mime': file.asset.mime,
            'base64': base64Encode(file.bytes),
          },
        )
        .toList(),
  });
}

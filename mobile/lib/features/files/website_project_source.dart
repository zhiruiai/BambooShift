import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'website_preview_content.dart';

class WebsiteProjectSource extends StatefulWidget {
  const WebsiteProjectSource({super.key, required this.content});
  final WebsitePreviewContent content;

  @override
  State<WebsiteProjectSource> createState() => _WebsiteProjectSourceState();
}

class _WebsiteProjectSourceState extends State<WebsiteProjectSource> {
  static const maxSourceUnits = 64 * 1024;
  late String path = widget.content.project.entry;
  late String? source = widget.content.files
      .firstWhere((file) => file.asset.path == path)
      .source;

  @override
  Widget build(BuildContext context) {
    final text = source;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Semantics(
            label: context.tr('mobileWebsiteFiles'),
            child: DropdownButton<String>(
              isExpanded: true,
              value: path,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(fontSize: 14),
              items: widget.content.files
                  .map(
                    (file) => DropdownMenuItem(
                      value: file.asset.path,
                      child: Text(
                        file.asset.path,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  )
                  .toList(),
              onChanged: (value) {
                if (value == null) return;
                setState(() {
                  path = value;
                  source = widget.content.files
                      .firstWhere((file) => file.asset.path == path)
                      .source;
                });
              },
            ),
          ),
        ),
        if (text == null)
          const Notice('mobileWebsiteBinary')
        else
          Expanded(
            child: ListView(
              key: ValueKey(path),
              padding: const EdgeInsets.all(12),
              children: [
                if (text.length > maxSourceUnits)
                  const Notice('mobileWebsiteSourceTruncated'),
                SelectableText(
                  text.length > maxSourceUnits
                      ? text.substring(0, maxSourceUnits)
                      : text,
                  style: const TextStyle(
                    fontSize: 13,
                    fontFamily: 'monospace',
                    height: 1.45,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

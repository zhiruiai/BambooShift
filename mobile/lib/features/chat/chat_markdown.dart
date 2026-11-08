import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import 'chat_link_launcher.dart';

class ChatMarkdown extends StatelessWidget {
  const ChatMarkdown({
    super.key,
    required this.text,
    required this.canOpenLink,
    this.openLink,
  });

  final String text;
  final bool Function() canOpenLink;
  final Future<bool> Function(Uri)? openLink;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final body = theme.textTheme.bodyMedium!.copyWith(
      fontSize: 15,
      height: 1.5,
    );
    final heading = body.copyWith(fontWeight: FontWeight.w600, height: 1.3);
    return SelectionArea(
      child: MarkdownBody(
        data: text,
        softLineBreak: true,
        onTapLink: (_, href, _) => openChatLink(
          context,
          href,
          isCurrent: canOpenLink,
          launcher: openLink,
        ),
        // Attachments use the authorized file viewer. Markdown never loads images.
        imageBuilder: (_, _, alt) => Text(alt ?? '', style: body),
        styleSheet: MarkdownStyleSheet.fromTheme(theme).copyWith(
          p: body,
          a: TextStyle(
            color: colors.primary,
            decoration: TextDecoration.underline,
          ),
          h1: heading.copyWith(fontSize: 22),
          h2: heading.copyWith(fontSize: 19),
          h3: heading.copyWith(fontSize: 17),
          h4: heading,
          h5: heading,
          h6: heading,
          code: body.copyWith(
            fontFamily: 'monospace',
            fontSize: 13,
            backgroundColor: colors.surfaceContainerHighest,
          ),
          codeblockDecoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(8),
          ),
          tableColumnWidth: const FixedColumnWidth(120),
          tableCellsPadding: const EdgeInsets.symmetric(
            horizontal: 8,
            vertical: 6,
          ),
          tableBorder: TableBorder.all(color: colors.outlineVariant),
        ),
      ),
    );
  }
}

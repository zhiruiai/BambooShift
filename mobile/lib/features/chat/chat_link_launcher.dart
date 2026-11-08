import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/safe_http_uri.dart';
import '../../l10n/strings.dart';

Future<void> openChatLink(
  BuildContext context,
  String? href, {
  required bool Function() isCurrent,
  Future<bool> Function(Uri)? launcher,
}) async {
  final uri = safeHttpUri(href);
  if (uri == null || !isCurrent()) return;

  try {
    final opened =
        await (launcher?.call(uri) ??
            launchUrl(uri, mode: LaunchMode.externalApplication));
    if (opened) return;
  } catch (_) {
    // Some devices have no browser registered for this link.
  }
  if (context.mounted && isCurrent()) {
    ScaffoldMessenger.maybeOf(
      context,
    )?.showSnackBar(SnackBar(content: Text(context.tr('requestFailed'))));
  }
}

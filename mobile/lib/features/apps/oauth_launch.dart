import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';

typedef BrowserLauncher = Future<bool> Function(Uri uri);

Uri oauthLaunchUri(
  Uri server,
  String workspaceId,
  String connectionId,
  String flowId,
  Object? launchPath,
) {
  final expected = '/app-authorize/$workspaceId/$connectionId/$flowId';
  final origin = parseServer(server.origin);
  if (launchPath != expected ||
      !RegExp(
        r'^/app-authorize/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$',
      ).hasMatch(expected)) {
    throw const ApiException('INVALID_LAUNCH', 'mobileAppsLaunchRejected');
  }
  return origin.resolve(expected);
}

Future<bool> launchOAuthBrowser(Uri uri) =>
    launchUrl(uri, mode: LaunchMode.externalApplication);

import '../../core/api.dart';

typedef CustomMcpTarget = ({String name, String url});

final _unsafeUrlText = RegExp(r'[\x00-\x20\x7f-\x9f\\]');

CustomMcpTarget? customMcpTarget(Json? proposal) {
  if (proposal?['kind'] != 'custom_mcp') return null;
  final url = proposal!['url'], name = proposal['name'];
  if (url is! String ||
      url.length > 2048 ||
      _unsafeUrlText.hasMatch(url) ||
      name is! String ||
      name.isEmpty ||
      name.length > 253) {
    return null;
  }
  final uri = Uri.tryParse(url);
  if (uri == null ||
      uri.scheme != 'https' ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.host == 'localhost' ||
      uri.host.endsWith('.localhost') ||
      uri.authority.contains('@') ||
      uri.port != 443 ||
      uri.hasQuery ||
      uri.hasFragment ||
      (name != uri.host &&
          !(uri.host.contains(':') && name == '[${uri.host}]'))) {
    return null;
  }
  return (name: name, url: url);
}

Json? findExactMcpConnection(String url, List<Json> apps) {
  // Custom paths can differ solely by their trailing slash.
  final matches = apps.where((app) => app['url'] == url);
  return matches.where((app) => app['status'] == 'connected').firstOrNull ??
      matches.firstOrNull;
}

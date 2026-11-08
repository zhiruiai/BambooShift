final _unsafeLinkCharacters = RegExp(r'[\s\x00-\x1f\x7f\\]');

Uri? safeHttpUri(String? value) {
  if (value == null || _unsafeLinkCharacters.hasMatch(value)) return null;
  final uri = Uri.tryParse(value);
  if (uri == null ||
      (uri.scheme != 'https' && uri.scheme != 'http') ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.authority.contains('@') ||
      (uri.hasPort && (uri.port < 1 || uri.port > 65535))) {
    return null;
  }
  return uri;
}

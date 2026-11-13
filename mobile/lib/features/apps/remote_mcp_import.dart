import 'dart:convert';

const int maxMcpImportLength = 65536;
typedef RemoteMcpCandidate = ({String name, String url});
typedef RemoteMcpImportResult = ({
  List<RemoteMcpCandidate> candidates,
  int skipped,
  String? error,
});

final _controls = RegExp(r'[\p{Cc}\p{Cf}]', unicode: true);
final _unsafeAddress = RegExp(r'[\s\\?#<>\p{Cc}\p{Cf}]|\$\{', unicode: true);
final _https = RegExp(r'^https:/*([^/]+)(?:/.*)?$', caseSensitive: false);
// Match JavaScript trim exactly; Dart also trims U+0085, which must remain invalid here.
final _trim = RegExp(
  r'^[\x09-\x0d\x20\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\x09-\x0d\x20\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
);

RemoteMcpImportResult _failure(String reason) =>
    (candidates: const [], skipped: 0, error: reason);

String? _address(Object? value) {
  if (value is! String ||
      utf8.encode(value).length > 2048 ||
      _unsafeAddress.hasMatch(value)) {
    return null;
  }
  final authority = _https.firstMatch(value)?.group(1);
  if (authority == null || authority.contains('@')) return null;
  // Uri is RFC 3986, not WHATWG: never rewrite percent escapes or approximate IDNA here.
  // The workspace's pure preview endpoint validates public hosts and canonicalizes both clients.
  return value;
}

Iterable<MapEntry<String, dynamic>> _entries(Map<String, dynamic> group) {
  int? index(String key) {
    final number = int.tryParse(key);
    return number != null &&
            number >= 0 &&
            number < 4294967295 &&
            number.toString() == key
        ? number
        : null;
  }

  final numbered =
      group.entries.where((entry) => index(entry.key) != null).toList()
        ..sort((a, b) => index(a.key)!.compareTo(index(b.key)!));
  return [
    ...numbered,
    ...group.entries.where((entry) => index(entry.key) == null),
  ];
}

/// Discards secrets locally; only names and raw HTTPS strings reach server preview.
/// A successful projection is not an approved connection or a validated public endpoint.
RemoteMcpImportResult parseRemoteMcpImport(String source) {
  if (source.length > maxMcpImportLength) return _failure('size');
  final Object? value;
  try {
    value = jsonDecode(source);
  } on FormatException {
    return _failure('json');
  }
  if (value is! Map<String, dynamic>) return _failure('shape');
  final root = value;
  final groups = ['mcpServers', 'servers'].where(root.containsKey).toList();
  if (groups.isEmpty ||
      groups.any((key) => root[key] is! Map<String, dynamic>)) {
    return _failure('shape');
  }
  final entries = groups
      .expand((key) => _entries(root[key] as Map<String, dynamic>))
      .toList();
  if (entries.length > 100) return _failure('count');
  final candidates = <RemoteMcpCandidate>[];
  final seen = <String>{};
  for (final item in entries) {
    final name = item.key.replaceAll(_trim, '');
    final entry = item.value;
    if (name.isEmpty ||
        name.length > 80 ||
        _controls.hasMatch(name) ||
        entry is! Map<String, dynamic> ||
        entry.containsKey('command') ||
        entry.containsKey('args') ||
        ['type', 'transport'].any(
          (field) =>
              entry.containsKey(field) &&
              !['http', 'streamable-http'].contains(entry[field]),
        )) {
      continue;
    }
    final url = _address(entry['url']);
    if (url != null && seen.add(url)) candidates.add((name: name, url: url));
  }
  return candidates.isEmpty
      ? _failure('empty')
      : (
          candidates: List.unmodifiable(candidates),
          skipped: entries.length - candidates.length,
          error: null,
        );
}

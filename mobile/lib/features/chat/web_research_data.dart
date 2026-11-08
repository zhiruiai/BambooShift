import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/safe_http_uri.dart';

typedef WebResearchSource = ({String title, Uri uri, bool page});

const _issues = {
  'search_task_limit',
  'search_retry_limit',
  'fetch_task_limit',
  'upstream_rate_limit',
  'timeout',
  'unavailable',
  'fetch_empty',
  'failed',
};
const _counts = ['searches', 'cachedSearches', 'emptySearches', 'pagesRead'];
final _controls = RegExp(r'[\x00-\x1f\x7f-\x9f]');
final _bidiControls = RegExp(r'[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]');
final _numericHostLabel = RegExp(r'^(?:[0-9]+|0x[0-9a-f]*)$');

Uri? _sourceUri(Object? url) {
  if (url is! String || url.length > 2048 || _controls.hasMatch(url)) {
    return null;
  }
  final uri = safeHttpUri(url);
  if (uri == null) return null;
  final host = uri.host.replaceFirst(RegExp(r'\.+$'), '').toLowerCase();
  if (!host.contains('.') ||
      host.contains(':') ||
      _numericHostLabel.hasMatch(host.split('.').last) ||
      const [
        '.localhost',
        '.local',
        '.internal',
        '.test',
        '.invalid',
      ].any(host.endsWith)) {
    return null;
  }
  return uri;
}

class WebResearch {
  const WebResearch._({
    required this.searches,
    required this.cachedSearches,
    required this.emptySearches,
    required this.pagesRead,
    required this.issues,
    required this.sources,
  });

  final int searches, cachedSearches, emptySearches, pagesRead;
  final List<String> issues;
  final List<WebResearchSource> sources;

  static WebResearch? fromMessage(Json message) {
    if (message['kind'] != 'web_research' ||
        message['role'] != 'assistant' ||
        message['status'] != 'done' ||
        !isChatReference(message['id']) ||
        !isChatReference(message['conversationId']) ||
        (message['threadRootId'] != null &&
            !isChatReference(message['threadRootId']))) {
      return null;
    }
    final metadata = message['metadata'];
    final value = metadata is Json ? metadata['webResearch'] : null;
    if (value is! Json ||
        value.length != 8 ||
        value['version'] != 1 ||
        value['provider'] != 'Exa' ||
        !_counts.every((key) {
          final count = value[key];
          return count is int && count >= 0 && count <= 9999;
        })) {
      return null;
    }
    final searches = value['searches'] as int;
    final cached = value['cachedSearches'] as int;
    final empty = value['emptySearches'] as int;
    final issues = value['issues'], sources = value['sources'];
    if (empty > searches ||
        issues is! List ||
        issues.length > _issues.length ||
        !issues.every(_issues.contains) ||
        sources is! List ||
        sources.length > 12) {
      return null;
    }
    final seen = <Uri>{};
    final validSources = <WebResearchSource>[];
    for (final source in sources) {
      if (source is! Json || source.length != 3) return null;
      final title = source['title'], kind = source['kind'];
      final uri = _sourceUri(source['url']);
      if (title is! String ||
          title.trim().isEmpty ||
          title.length > 240 ||
          _controls.hasMatch(title) ||
          _bidiControls.hasMatch(title) ||
          !{'search', 'page'}.contains(kind) ||
          uri == null ||
          !seen.add(uri)) {
        return null;
      }
      validSources.add((title: title, uri: uri, page: kind == 'page'));
    }
    return WebResearch._(
      searches: searches,
      cachedSearches: cached,
      emptySearches: empty,
      pagesRead: value['pagesRead'] as int,
      issues: List.unmodifiable(issues.cast<String>().toSet()),
      sources: List.unmodifiable(validSources),
    );
  }
}

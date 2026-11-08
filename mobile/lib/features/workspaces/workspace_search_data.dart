import '../../core/api.dart';
import '../../core/message_links.dart';
import '../chat/file_preview_data.dart';
import '../files/website_project_data.dart';

enum SearchKind {
  message('mobileSearchMessages'),
  bot('bots'),
  group('mobileSearchGroups'),
  file('mobileSearchFiles'),
  routine('mobileSearchRoutines'),
  website('mobileSearchWebsites'),
  link('mobileSearchLinks');

  const SearchKind(this.label);
  final String label;
}

class WorkspaceSearchHit {
  WorkspaceSearchHit({
    required this.kind,
    required this.id,
    required this.title,
    this.detail = '',
    this.context = '',
    this.url,
    this.websiteVersion,
    Object? timestamp,
  }) : time = DateTime.tryParse(_text(timestamp))?.millisecondsSinceEpoch ?? 0;

  final SearchKind kind;
  final String id, title, detail, context;
  final Uri? url;
  final String? websiteVersion;
  final int time;
  String get key => '${kind.name}:$id${url == null ? '' : ':$url'}';
  late final String _searchable = _normalize('$title $detail $context');

  String snippet(String query) {
    final plain = detail.replaceAll(_whitespace, ' ').trim();
    const length = 140;
    if (plain.length <= length) return plain;
    final lower = _foldWidth(plain).toLowerCase();
    final positions = _terms(query).map(lower.indexOf).where((i) => i >= 0);
    final first = positions.fold(plain.length, (a, b) => a < b ? a : b);
    final start = first == plain.length ? 0 : (first - 30).clamp(0, first);
    final end = (start + length).clamp(start, plain.length);
    return '${start > 0 ? '…' : ''}${plain.substring(start, end)}'
        '${end < plain.length ? '…' : ''}';
  }
}

class WorkspaceSearchIndex {
  WorkspaceSearchIndex(Json data) {
    final conversations = {
      for (final chat in _rows(data, 'conversations')) chat['id']: chat,
    };
    final bots = {for (final bot in _rows(data, 'agents')) bot['id']: bot};
    void add(
      SearchKind kind,
      Json row,
      Object? title, {
      String detail = '',
      String context = '',
      Uri? url,
      String? websiteVersion,
      Object? time,
    }) {
      final id = row['id'];
      if (id is! String || id.isEmpty || _text(title).trim().isEmpty) return;
      entries[kind]!.add(
        WorkspaceSearchHit(
          kind: kind,
          id: id,
          title: title as String,
          detail: detail,
          context: context,
          url: url,
          websiteVersion: websiteVersion,
          timestamp: time ?? row['createdAt'],
        ),
      );
    }

    for (final chat in conversations.values.where(
      (c) => c['isGroup'] == true,
    )) {
      final members = chat['agentIds'];
      add(
        SearchKind.group,
        chat,
        chat['title'],
        detail: members is List
            ? members.map((id) => _text(bots[id]?['name'])).join(' ').trim()
            : '',
        time: chat['updatedAt'],
      );
    }
    for (final bot in bots.values) {
      add(
        SearchKind.bot,
        bot,
        bot['name'],
        detail: _text(bot['role']),
        context: _text(bot['description']),
        time: bot['updatedAt'],
      );
    }
    for (final message in _rows(data, 'messages')) {
      final chat = conversations[message['conversationId']];
      if (chat == null) continue;
      final project = websiteProjectFor(message);
      if (project != null && message['status'] != 'running') {
        add(
          SearchKind.website,
          message,
          project.title,
          detail: _text(chat['title']),
          context: project.entry,
          websiteVersion: project.id,
        );
      }
      for (final link in messageLinks(message)) {
        add(
          SearchKind.link,
          message,
          link.label,
          detail: link.uri.toString(),
          context: _text(chat['title']),
          url: link.uri,
        );
      }
      final content = _text(message['content']);
      if (content.trim().isEmpty) continue;
      final metadata = message['metadata'];
      final author = metadata is Json ? metadata['author'] : null;
      add(
        SearchKind.message,
        message,
        chat['title'],
        detail: content,
        context: _text(
          bots[message['agentId']]?['name'] ??
              (author is Json ? author['name'] : null),
        ),
      );
    }
    for (final file in _rows(data, 'files')) {
      final chatId = file['conversationId'];
      if (chatId != null && !conversations.containsKey(chatId)) continue;
      final parsed = ChatFile.fromWorkspace(file);
      if (parsed == null) continue;
      add(
        SearchKind.file,
        file,
        parsed.name,
        detail: _text(conversations[chatId]?['title']),
      );
    }
    for (final routine in _rows(data, 'routines')) {
      final chat = conversations[routine['conversationId']];
      add(
        SearchKind.routine,
        routine,
        routine['title'],
        detail: _text(bots[routine['agentId']]?['name'] ?? chat?['title']),
        context: _text(routine['prompt']),
        time: routine['nextRunAt'],
      );
    }
    for (final group in entries.values) {
      group.sort((a, b) {
        final byTime = b.time.compareTo(a.time);
        return byTime != 0 ? byTime : a.key.compareTo(b.key);
      });
    }
  }

  final entries = {
    for (final kind in SearchKind.values) kind: <WorkspaceSearchHit>[],
  };

  ({List<WorkspaceSearchHit> hits, bool truncated}) search(
    String query,
    SearchKind? kind,
  ) {
    final terms = _terms(query);
    Iterable<WorkspaceSearchHit> matches(SearchKind category) =>
        entries[category]!.where(
          (hit) => terms.every(hit._searchable.contains),
        );

    if (kind != null) return (hits: matches(kind).toList(), truncated: false);

    const previewLimit = 8;
    final hits = <WorkspaceSearchHit>[];
    var truncated = false;
    for (final category in SearchKind.values) {
      final preview = matches(category).take(previewLimit + 1).toList();
      hits.addAll(preview.take(previewLimit));
      truncated = truncated || preview.length > previewLimit;
    }
    return (hits: hits, truncated: truncated);
  }
}

Iterable<Json> _rows(Json data, String key) {
  final value = data[key];
  return value is List ? value.whereType<Json>() : const [];
}

String _text(Object? value) => value is String ? value : '';
final _whitespace = RegExp(r'\s+');
final _wideCharacters = RegExp(r'[\u3000\uFF01-\uFF5E]');
String _foldWidth(String value) =>
    value.replaceAllMapped(_wideCharacters, (match) {
      final code = value.codeUnitAt(match.start);
      return String.fromCharCode(code == 0x3000 ? 0x20 : code - 0xFEE0);
    });
String _normalize(String value) =>
    _foldWidth(value).toLowerCase().replaceAll(_whitespace, ' ').trim();
Set<String> _terms(String value) =>
    _normalize(value).split(' ').where((term) => term.isNotEmpty).toSet();

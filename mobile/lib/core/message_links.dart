import 'package:markdown/markdown.dart' as md;

import 'api.dart';
import 'safe_http_uri.dart';

typedef MessageLink = ({Uri uri, String label});
final _linkText = RegExp(r'https?://|www\.', caseSensitive: false);
final _whitespace = RegExp(r'\s+');
final _indexed = Expando<({String content, List<MessageLink> links})>();

List<MessageLink> messageLinks(Json message) {
  final kind = message['kind'];
  final content = message['content'];
  if ((message['role'] != 'user' && message['role'] != 'assistant') ||
      (kind != null && kind != 'text') ||
      message['status'] == 'running' ||
      content is! String ||
      content.isEmpty) {
    return const [];
  }
  final cached = _indexed[message];
  if (cached != null && cached.content == content) return cached.links;
  final text = content.length > 32768 ? content.substring(0, 32768) : content;
  if (!_linkText.hasMatch(text)) return const [];
  final nodes = md.Document(
    extensionSet: md.ExtensionSet.gitHubFlavored,
    encodeHtml: false,
  ).parse(text);
  final seen = <Uri>{};
  final links = <MessageLink>[];
  for (final anchor in _anchors(nodes)) {
    final href = anchor.attributes['href'];
    if (href == null || href.length > 2048) continue;
    final uri = safeHttpUri(href);
    if (uri == null || !seen.add(uri)) continue;
    final label = anchor.textContent.replaceAll(_whitespace, ' ').trim();
    links.add((uri: uri, label: label.isEmpty ? uri.toString() : label));
    if (seen.length >= 64) break;
  }
  final results = List<MessageLink>.unmodifiable(links);
  _indexed[message] = (content: content, links: results);
  return results;
}

Iterable<md.Element> _anchors(Iterable<md.Node> nodes) sync* {
  final pending = nodes.toList().reversed.toList();
  while (pending.isNotEmpty) {
    final node = pending.removeLast();
    if (node is! md.Element) continue;
    if (node.tag == 'a') {
      yield node;
    } else if (!const {'img', 'pre', 'code'}.contains(node.tag)) {
      pending.addAll(node.children?.reversed ?? const []);
    }
  }
}

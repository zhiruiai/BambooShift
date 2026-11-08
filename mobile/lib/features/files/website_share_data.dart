import '../../core/api.dart';
import '../../core/request_ids.dart';
import 'website_project_client.dart';

enum WebsiteVisibility { private, invited, team, public }

const maxWebsiteShareViewers = 80;

const websiteVisibilityLabels = {
  WebsiteVisibility.private: 'mobileWebsiteSharePrivate',
  WebsiteVisibility.invited: 'mobileWebsiteShareInvited',
  WebsiteVisibility.team: 'mobileWebsiteShareTeam',
  WebsiteVisibility.public: 'mobileWebsiteSharePublic',
};

final _tokenPath = RegExp(r'^/pages/[a-zA-Z0-9_-]{43}$');
final _id = RegExp(r'^[a-zA-Z0-9_-]{1,128}$');
final _version = RegExp(r'^[a-f0-9]{64}$');

typedef WebsiteShare = ({
  WebsiteVisibility visibility,
  String? revision,
  String? versionId,
  List<String> viewers,
  String? path,
});
typedef WebsiteViewer = ({String id, String name});

WebsiteShare parseWebsiteShare(Json value) {
  final visibility = WebsiteVisibility.values
      .where((item) => item.name == value['visibility'])
      .firstOrNull;
  final revision = value['revision'], version = value['versionId'];
  final viewers = value['viewerIds'], path = value['path'];
  if (visibility == null ||
      (revision != null &&
          (!isRequestId(revision) ||
              revision != revision.toString().toLowerCase())) ||
      (version != null &&
          (version is! String || !_version.hasMatch(version))) ||
      viewers is! List ||
      viewers.length > maxWebsiteShareViewers ||
      viewers.any((id) => id is! String || !_id.hasMatch(id)) ||
      viewers.toSet().length != viewers.length ||
      (visibility != WebsiteVisibility.invited && viewers.isNotEmpty) ||
      (visibility == WebsiteVisibility.private
          ? path != null || version != null
          : path is! String ||
                !_tokenPath.hasMatch(path) ||
                revision == null ||
                version == null)) {
    throw const FormatException('Invalid website sharing settings');
  }
  return (
    visibility: visibility,
    revision: revision as String?,
    versionId: version as String?,
    viewers: List.unmodifiable(viewers.cast<String>()),
    path: path as String?,
  );
}

class WebsiteShareClient {
  WebsiteShareClient(this.client);
  final WebsiteProjectClient client;
  bool get active => client.active;
  bool get team => client.scope.session.workspace?['kind'] == 'team';
  String get _path => '/website-projects/${client.project.id}/share';

  void _guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  Future<WebsiteShare> load() async {
    _guard();
    final value = await client.scope.request('GET', _path);
    _guard();
    return parseWebsiteShare(value);
  }

  Future<List<WebsiteViewer>> viewers() async {
    _guard();
    if (!team) return [];
    final scope = client.scope;
    final result = await scope.session.api.request(
      'GET',
      '/api/account/workspaces/${Uri.encodeComponent(scope.workspaceId)}/team',
      expectedUser: scope.userId,
    );
    _guard();
    final rows = result['members'];
    if (rows is! List) throw const FormatException('Invalid team members');
    final seen = <String>{};
    final members = <WebsiteViewer>[];
    for (final row in rows) {
      if (row is! Json || row['status'] is! String) {
        throw const FormatException('Invalid team member');
      }
      if (row['status'] != 'active') continue;
      if (row case {
        'userId': final String id,
        'name': final String name,
      } when _id.hasMatch(id) && seen.add(id)) {
        members.add((id: id, name: name));
      } else {
        throw const FormatException('Invalid active team member');
      }
    }
    return List.unmodifiable(members);
  }

  Future<WebsiteShare> save({
    required WebsiteShare previous,
    required WebsiteVisibility visibility,
    required List<String> viewers,
    required bool rotate,
  }) async {
    _guard();
    final result = await client.scope.request(
      'PUT',
      _path,
      body: {
        'visibility': visibility.name,
        'expectedRevision': previous.revision,
        if (visibility == WebsiteVisibility.invited) 'viewerIds': viewers,
        if (rotate) 'rotate': true,
      },
    );
    _guard();
    final next = parseWebsiteShare(result);
    if (next.visibility != visibility ||
        (visibility != WebsiteVisibility.private &&
            next.versionId != client.project.id) ||
        (visibility == WebsiteVisibility.invited &&
            (next.viewers.length != viewers.length ||
                !next.viewers.toSet().containsAll(viewers))) ||
        (rotate && next.path == previous.path)) {
      throw const FormatException('Website share receipt does not match');
    }
    return next;
  }

  Uri? address(WebsiteShare? share) {
    final path = share?.path;
    final server = client.scope.session.api.server;
    if (!active ||
        server == null ||
        path == null ||
        !_tokenPath.hasMatch(path)) {
      return null;
    }
    return server.resolve(path);
  }
}

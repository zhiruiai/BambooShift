import '../../core/api.dart';
import '../../core/request_ids.dart';

final _skillId = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
final _sourceRevision = RegExp(r'^[a-f0-9]{64}$');
const _invalid = ApiException('INVALID_TEAM_PUBLICATION', 'requestUnknown');

typedef TeamPublication = ({
  String id,
  String revision,
  int version,
  String sourceRevision,
  String? linkId,
});
typedef TeamPublicationTarget = ({
  String id,
  String name,
  TeamPublication? publication,
  String? policyRevision,
});

TeamPublication _publication(Object? value) {
  if (value is! Json ||
      !isRequestId(value['id']) ||
      !isRequestId(value['revision']) ||
      (value['linkId'] != null && !isRequestId(value['linkId'])) ||
      value['version'] is! int ||
      value['version'] < 1 ||
      value['sourceRevision'] is! String ||
      !_sourceRevision.hasMatch(value['sourceRevision'] as String)) {
    throw _invalid;
  }
  return (
    id: value['id'] as String,
    revision: value['revision'] as String,
    version: value['version'] as int,
    sourceRevision: value['sourceRevision'] as String,
    linkId: value['linkId'] as String?,
  );
}

List<TeamPublicationTarget> publicationTargets(Object? value) {
  if (value is! Json || value['teams'] is! List) throw _invalid;
  final ids = <String>{};
  return List.unmodifiable(
    (value['teams'] as List).map((item) {
      if (item is! Json ||
          !isRequestId(item['workspaceId']) ||
          !ids.add(item['workspaceId'] as String) ||
          item['workspaceName'] is! String ||
          (item['workspaceName'] as String).trim().isEmpty ||
          (item['workspaceName'] as String).length > 160 ||
          (item['policyRevision'] != null &&
              !isRequestId(item['policyRevision'])) ||
          !item.containsKey('publication')) {
        throw _invalid;
      }
      return (
        id: item['workspaceId'] as String,
        name: item['workspaceName'] as String,
        policyRevision: item['policyRevision'] as String?,
        publication: item['publication'] == null
            ? null
            : _publication(item['publication']),
      );
    }),
  );
}

class TeamPublicationRequest {
  const TeamPublicationRequest({
    required this.id,
    required this.skillId,
    required this.sourceRevision,
    required this.teamId,
    required this.teamName,
  });

  final String id, skillId, sourceRevision, teamId, teamName;
  String get path => '/private-skills/$skillId/team-publications/$teamId';
  String get receiptPath => '$path/$id';

  Json toJson() => {
    'id': id,
    'skillId': skillId,
    'sourceRevision': sourceRevision,
    'teamId': teamId,
    'teamName': teamName,
  };

  factory TeamPublicationRequest.parse(Object? value) {
    if (value is! Json ||
        !isRequestId(value['id']) ||
        !isRequestId(value['teamId']) ||
        value['skillId'] is! String ||
        !_skillId.hasMatch(value['skillId'] as String) ||
        value['sourceRevision'] is! String ||
        !_sourceRevision.hasMatch(value['sourceRevision'] as String) ||
        value['teamName'] is! String ||
        (value['teamName'] as String).trim().isEmpty ||
        (value['teamName'] as String).length > 160) {
      throw _invalid;
    }
    return TeamPublicationRequest(
      id: value['id'] as String,
      skillId: value['skillId'] as String,
      sourceRevision: value['sourceRevision'] as String,
      teamId: value['teamId'] as String,
      teamName: value['teamName'] as String,
    );
  }

  TeamPublication? receipt(Object? value, {required bool mayBeCancelled}) {
    if (value is! Json) throw _invalid;
    if (mayBeCancelled &&
        value['status'] == 'cancelled' &&
        value['publication'] == null) {
      return null;
    }
    final publication = _publication(value['publication']);
    if (publication.sourceRevision != sourceRevision) throw _invalid;
    return publication;
  }
}

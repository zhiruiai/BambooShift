import '../../core/api.dart';
import '../../core/request_ids.dart';
import 'library_data.dart';

bool grantHash(Object? v) =>
    v is String && RegExp(r'^[a-f0-9]{64}$').hasMatch(v);
bool grantName(Object? v, int max) =>
    libraryText(v, max, empty: false) &&
    !RegExp(r'[\x00-\x1f\x7f]').hasMatch(v as String);
bool grantToolName(Object? v) =>
    v is String && RegExp(r'^[A-Za-z0-9_.:/-]{1,128}$').hasMatch(v);
Json sharedFile(Object? value, {bool inspected = true}) {
  if (value is! Json ||
      !libraryId(value['fileId']) ||
      !grantName(value['name'], 4096) ||
      (value['name'] as String).contains(RegExp(r'[/\\]')) ||
      value['size'] is! int ||
      value['size'] < 0 ||
      value['size'] > 10 * 1024 * 1024 ||
      !libraryText(value['type'], 200) ||
      RegExp(r'[\x00-\x1f\x7f]').hasMatch(value['type']) ||
      (value['status'] != null &&
          !{
            'available',
            'changed',
            'missing',
            'unavailable',
          }.contains(value['status'])) ||
      (inspected && !grantHash(value['revision']))) {
    invalidLibrary();
  }
  return libraryCopy(value);
}

Json sharedApp(Object? value, {bool inspected = true, bool schema = false}) {
  if (value is! Json ||
      !isRequestId(value['connectionId']) ||
      !grantName(value['name'], 80)) {
    invalidLibrary();
  }
  if (inspected &&
      value['status'] != null &&
      !{'available', 'changed'}.contains(value['status'])) {
    invalidLibrary();
  }
  if (inspected) {
    if (!isRequestId(value['connectionRevision']) ||
        value['tools'] is! List ||
        (value['tools'] as List).length > 64) {
      invalidLibrary();
    }
    final names = <String>{};
    for (final tool in value['tools']) {
      if (tool is! Json ||
          !grantToolName(tool['name']) ||
          !grantHash(tool['revision']) ||
          !names.add(tool['name']) ||
          (schema &&
              (!libraryText(tool['description'], 4000) ||
                  tool['inputSchema'] is! Json ||
                  tool['inputSchema']['type'] != 'object'))) {
        invalidLibrary();
      }
    }
  } else if (!{
        'connected',
        'disconnected',
        'needs_auth',
        'error',
      }.contains(value['status']) ||
      value['toolCount'] is! int ||
      value['toolCount'] < 0 ||
      value['toolCount'] > 64) {
    invalidLibrary();
  }
  return libraryCopy(value);
}

Json sharingSnapshot(Object? value, String wid, String agent) {
  if (value is! Json || value['teams'] is! List) invalidLibrary();
  final teams = libraryRows(value['teams']);
  final teamIds = <String>{};
  for (final team in teams) {
    if (!isRequestId(team['id']) ||
        !teamIds.add(team['id']) ||
        !grantName(team['name'], 200) ||
        team['members'] is! List) {
      invalidLibrary();
    }
    final ids = <String>{};
    for (final member in libraryRows(team['members'])) {
      if (!libraryId(member['userId']) ||
          !ids.add(member['userId']) ||
          !grantName(member['name'], 200)) {
        invalidLibrary();
      }
    }
  }
  final share = value['share'];
  if (share != null) {
    if (share is! Json ||
        !isRequestId(share['id']) ||
        share['sourceWorkspaceId'] != wid ||
        share['sourceAgentId'] != agent ||
        !isRequestId(share['targetTeamId']) ||
        !isRequestId(share['revision']) ||
        !{'team', 'selected'}.contains(share['audience']) ||
        !{'active', 'revoked'}.contains(share['status']) ||
        share['memberIds'] is! List ||
        !(share['memberIds'] as List).every(libraryId)) {
      invalidLibrary();
    }
    if (share['files'] != null) {
      if (libraryRows(share['files']).length > 32) invalidLibrary();
      for (final row in libraryRows(share['files'])) {
        sharedFile(row);
      }
    }
    if (share['apps'] != null) {
      if (libraryRows(share['apps']).length > 20) invalidLibrary();
      for (final row in libraryRows(share['apps'])) {
        sharedApp(row);
      }
    }
  }
  return libraryCopy(value);
}

Json fileGrant(Json value) => {
  'fileId': value['fileId'],
  'revision': value['revision'],
};
Json appGrant(Json value) => {
  'connectionId': value['connectionId'],
  'connectionRevision': value['connectionRevision'],
  'tools': [
    for (final t in value['tools'])
      {'name': t['name'], 'revision': t['revision']},
  ],
};

import 'dart:convert';
import '../../core/api.dart';
import '../../core/request_ids.dart';

bool libraryId(Object? value) =>
    value is String && RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(value);
bool templateToken(Object? value) =>
    value is String && RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(value);
bool revision(Object? value) =>
    isRequestId(value) ||
    value is String && RegExp(r'^[a-f0-9]{64}$').hasMatch(value);
bool libraryText(Object? value, int max, {bool empty = true}) =>
    value is String &&
    value.length <= max &&
    !value.contains('\u0000') &&
    (empty || value.trim().isNotEmpty);
Json libraryCopy(Json value) => jsonDecode(jsonEncode(value)) as Json;
Never invalidLibrary() =>
    throw const ApiException('INVALID_LIBRARY', 'mobileLibraryInvalid');

bool onlyLibraryFields(Json value, Set<String> allowed) =>
    value.keys.every(allowed.contains);
bool librarySchedule(Object? value) {
  if (value is! String || value.length > 80) return false;
  bool clock(String v) {
    final match = RegExp(r'^(\d{2}):(\d{2})$').firstMatch(v);
    return match != null &&
        int.parse(match[1]!) < 24 &&
        int.parse(match[2]!) < 60;
  }

  if (value.startsWith('daily:')) return clock(value.substring(6));
  if (value.startsWith('interval:')) {
    final v = value.substring(9);
    final n = int.tryParse(v);
    return RegExp(r'^\d+$').hasMatch(v) && n != null && n > 0 && n <= 525600;
  }
  final match = RegExp(r'^weekly:([1-7](?:,[1-7])*):(.*)$').firstMatch(value);
  if (match == null) return false;
  final days = match[1]!.split(',');
  return days.toSet().length == days.length && clock(match[2]!);
}

Json blueprint(Object? value) {
  if (value is! Json ||
      !onlyLibraryFields(value, {
        'version',
        'profile',
        'skills',
        'routines',
        'avatar',
      }) ||
      value['version'] != 1 ||
      value['profile'] is! Json ||
      value['skills'] is! List ||
      value['routines'] is! List ||
      utf8.encode(jsonEncode(value)).length > 2 * 1024 * 1024) {
    invalidLibrary();
  }
  final p = value['profile'] as Json;
  if (!onlyLibraryFields(p, {
        'name',
        'role',
        'description',
        'instructions',
        'avatar',
        'color',
      }) ||
      !libraryText(p['name'], 40, empty: false) ||
      !libraryText(p['role'], 80, empty: false) ||
      !libraryText(p['description'], 1000) ||
      !libraryText(p['instructions'], 16000) ||
      !{'orb', 'drop', 'leaf', 'spark', 'gem', 'arch'}.contains(p['avatar']) ||
      p['color'] is! String ||
      !RegExp(r'^#[a-fA-F0-9]{6}$').hasMatch(p['color'])) {
    invalidLibrary();
  }
  if ((value['skills'] as List).length > 100 ||
      (value['routines'] as List).length > 100) {
    invalidLibrary();
  }
  final names = <String>{};
  for (final s in value['skills'] as List) {
    if (s is! Json ||
        !onlyLibraryFields(s, {'name', 'description', 'content'}) ||
        !libraryText(s['name'], 100, empty: false) ||
        !libraryText(s['description'], 1000) ||
        !libraryText(s['content'], 16000, empty: false) ||
        !names.add((s['name'] as String).trim())) {
      invalidLibrary();
    }
  }
  for (final r in value['routines'] as List) {
    if (r is! Json ||
        !onlyLibraryFields(r, {
          'title',
          'prompt',
          'schedule',
          'enabled',
          'timeZone',
        }) ||
        !libraryText(r['title'], 100, empty: false) ||
        !libraryText(r['prompt'], 12000, empty: false) ||
        !librarySchedule(r['schedule']) ||
        r['enabled'] is! bool ||
        (r['timeZone'] != null &&
            !libraryText(r['timeZone'], 100, empty: false))) {
      invalidLibrary();
    }
  }
  if (value['avatar'] != null) {
    final a = value['avatar'];
    if (a is! Json ||
        !onlyLibraryFields(a, {'mimeType', 'width', 'height', 'sha256'}) ||
        a['mimeType'] != 'image/webp' ||
        a['width'] != 512 ||
        a['height'] != 512 ||
        a['sha256'] is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(a['sha256'])) {
      invalidLibrary();
    }
  }
  return libraryCopy(value);
}

Json publishedTemplate(Object? value) {
  if (value is! Json ||
      !templateToken(value['token']) ||
      !revision(value['revision']) ||
      !{'public', 'team'}.contains(value['audience'])) {
    invalidLibrary();
  }
  blueprint(value['blueprint']);
  return libraryCopy(value);
}

Json sourceBlueprint(Object? value) {
  if (value is! Json || !revision(value['sourceRevision'])) invalidLibrary();
  blueprint(value['blueprint']);
  return libraryCopy(value);
}

Json ownedTemplate(Object? value) {
  if (value is! Json ||
      !isRequestId(value['id']) ||
      !isRequestId(value['revision']) ||
      !isRequestId(value['draftRevision']) ||
      value['projectionPending'] is! bool ||
      !libraryId(value['sourceAgentId']) ||
      !libraryId(value['sourceConversationId'])) {
    invalidLibrary();
  }
  blueprint(value['blueprint']);
  if (value['publication'] != null) {
    final p = value['publication'];
    if (p is! Json ||
        !isRequestId(p['revision']) ||
        !{'public', 'team'}.contains(p['audience']) ||
        p['path'] is! String ||
        !RegExp(r'^/templates/[A-Za-z0-9_-]{43}$').hasMatch(p['path'])) {
      invalidLibrary();
    }
  }
  return libraryCopy(value);
}

Json sharedCard(Object? value) {
  if (value is! Json ||
      !isRequestId(value['id']) ||
      !libraryText(value['name'], 40, empty: false) ||
      !libraryText(value['role'], 80, empty: false) ||
      !libraryText(value['description'], 1000) ||
      !libraryText(value['ownerName'], 200) ||
      !libraryText(value['teamName'], 200) ||
      ![
        'skillCount',
        'fileCount',
        'appCount',
      ].every((k) => value[k] is int && value[k] >= 0) ||
      !revision(value['sourceRevision'])) {
    invalidLibrary();
  }
  return libraryCopy(value);
}

List<Json> libraryRows(Object? value) {
  if (value is! List || value.length > 2000 || value.any((v) => v is! Json)) {
    invalidLibrary();
  }
  return value.cast<Json>();
}

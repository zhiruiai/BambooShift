import 'dart:convert';
import 'package:crypto/crypto.dart';
import '../../core/api.dart';
import '../../core/request_ids.dart';
import 'library_data.dart';
import 'library_transport.dart';

class LibraryPending {
  LibraryPending(this.transport, this.purpose);
  final LibraryTransport transport;
  final String purpose;
  Json? value;
  String get key => transport.scope.session.api.vault.key(
    transport.scope.session.api.server!.origin,
    'bot-library:${transport.scope.userId}:${transport.scope.workspaceId}:$purpose',
  );
  Future<void> load() async {
    transport.guard();
    final raw = await transport.scope.session.api.vault.store.read(key);
    transport.guard();
    if (raw == null) {
      value = null;
      return;
    }
    final data = jsonDecode(raw);
    if (data is! Json ||
        data['version'] != 1 ||
        !isRequestId(data['requestId']) ||
        !libraryId(data['workspaceId']) ||
        !{
          'import',
          'copy',
          'join',
          'templateCreate',
          'templateEdit',
          'templateRefresh',
          'templatePublish',
          'templateRevoke',
          'templatePolicy',
          'shareUpdate',
          'shareRevoke',
        }.contains(data['kind']) ||
        !libraryText(data['sourceId'], 128, empty: false) ||
        data['digest'] is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(data['digest']) ||
        data.keys.any(
          (k) => !{
            'version',
            'kind',
            'requestId',
            'workspaceId',
            'sourceId',
            'expectedRevision',
            'digest',
          }.contains(k),
        ) ||
        (data['expectedRevision'] != null &&
            !revision(data['expectedRevision']) &&
            data['expectedRevision'] != 'unset')) {
      throw const ApiException('INVALID_PENDING', 'mobileLibraryStorage');
    }
    value = data;
  }

  Future<void> claim(String kind, String wid, String source, Json body) async {
    await transport.scope.session.api.vault.serial(() async {
      await load();
      if (value != null) {
        throw const ApiException('PENDING', 'mobileLibraryUnknown');
      }
      final marker = <String, dynamic>{
        'version': 1,
        'kind': kind,
        'requestId': body['requestId'],
        'workspaceId': wid,
        'sourceId': source,
        'digest': sha256.convert(utf8.encode(jsonEncode(body))).toString(),
        if (body['expectedRevision'] != null ||
            body['expectedSourceRevision'] != null)
          'expectedRevision':
              body['expectedRevision'] ?? body['expectedSourceRevision'],
      };
      await transport.scope.session.api.vault.store.write(
        key,
        jsonEncode(marker),
      );
      transport.guard();
      value = marker;
    });
  }

  Future<void> clear(Json expected) async {
    await transport.scope.session.api.vault.serial(() async {
      await load();
      if (value?['requestId'] != expected['requestId']) {
        throw const ApiException('PENDING_CHANGED', 'mobileLibraryStorage');
      }
      await transport.scope.session.api.vault.store.delete(key);
      transport.guard();
      value = null;
    });
  }
}

import 'dart:typed_data';

import 'api.dart';
import 'binary_transport.dart';
import 'byte_read.dart';
import 'request_ids.dart';
import 'workspace_controller.dart';

String? botAvatarPath(WorkspaceController scope, Json profile) {
  if (profile.containsKey('sharedBot')) {
    final shared = profile['sharedBot'];
    final path = shared is Json ? shared['avatarPath'] : null;
    final id = shared is Json ? shared['shareId'] : null;
    if (path is! String || !isRequestId(id)) return null;
    final uri = Uri.tryParse(path);
    final revision = uri?.queryParameters['revision'];
    if (revision == null || !RegExp(r'^[a-f0-9]{64}$').hasMatch(revision)) {
      return null;
    }
    return path == '/api/shared-bots/$id/avatar?revision=$revision'
        ? path
        : null;
  }
  final id = profile['avatarImageId'];
  return isRequestId(id) ? scope.path('/bot-avatars/$id') : null;
}

Future<Uint8List> readAvatarImage(
  WorkspaceController scope,
  String path, {
  required bool Function() current,
  required ByteReadCancellation cancellation,
  int maximum = 512 * 1024,
}) async {
  const invalidImage = ApiException('INVALID_IMAGE', 'avatarImageUnavailable');
  final result = await readBoundedBinary(
    scope.session.api,
    path,
    expectedUser: scope.userId,
    isCurrent: current,
    cancellation: cancellation,
    maximum: maximum,
    accept: 'image/webp',
    unavailable: 'avatarImageUnavailable',
    failed: 'avatarImageUnavailable',
    tooLarge: 'avatarImageUnavailable',
    validateHeaders: (headers) {
      if (headers['content-type']?.split(';').first.trim().toLowerCase() !=
          'image/webp') {
        throw invalidImage;
      }
    },
  );
  final data = result.bytes;
  if (data.length < 12 ||
      String.fromCharCodes(data.sublist(0, 4)) != 'RIFF' ||
      String.fromCharCodes(data.sublist(8, 12)) != 'WEBP' ||
      ByteData.sublistView(data).getUint32(4, Endian.little) + 8 !=
          data.length) {
    throw invalidImage;
  }
  return data;
}

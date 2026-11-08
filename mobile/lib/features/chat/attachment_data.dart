import '../../core/api.dart';

const attachmentLimit = 10 * 1024 * 1024;
const attachmentCount = 4;
final attachmentId = RegExp(r'^[A-Za-z0-9_-]{1,128}$');

String attachmentName(Object? value) {
  if (value is! String ||
      value.trim().isEmpty ||
      value.length > 160 ||
      value == '.' ||
      value == '..' ||
      value.startsWith('.openbot-') ||
      RegExp(r'[/\\\x00-\x1f\x7f]').hasMatch(value)) {
    throw const ApiException('INVALID_FILE', 'mobileFilesInvalid');
  }
  return value;
}

String attachmentType(String? value) =>
    value != null &&
        value.length <= 160 &&
        RegExp(r'^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$').hasMatch(value)
    ? value
    : 'application/octet-stream';

Json attachmentFile(Object? value, String conversationId) {
  if (value is! Json ||
      !attachmentId.hasMatch(value['id'] as String? ?? '') ||
      value['conversationId'] != conversationId ||
      value['size'] is! int ||
      value['size'] < 0 ||
      value['size'] > attachmentLimit ||
      value['type'] is! String) {
    throw const ApiException('INVALID_FILE', 'requestUnknown');
  }
  return {
    'id': value['id'],
    'name': attachmentName(value['name']),
    'size': value['size'],
    'type': value['type'],
    'conversationId': conversationId,
  };
}

bool possibleAttachment(Json file, Json pending) {
  final name = file['name'];
  return name is String &&
      (name == pending['name'] ||
          RegExp(
            '^[0-9a-f]{8}-${RegExp.escape(pending['name'] as String)}\$',
          ).hasMatch(name)) &&
      file['size'] == pending['size'] &&
      file['type'] == pending['type'] &&
      file['conversationId'] == pending['conversationId'];
}

String attachmentReference(Json file, String workspaceId) {
  final name = (file['name'] as String).replaceAllMapped(
    RegExp(r'[\\\[\]]'),
    (m) => '\\${m[0]}',
  );
  return '[$name](/api/workspaces/$workspaceId/files/${file['id']}/download)';
}

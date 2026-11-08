import 'api.dart';
import 'binary_transport.dart';
import 'byte_read.dart';

extension WorkspaceFileBytes on ApiClient {
  Future<FileBytes> readWorkspaceFile(
    String workspaceId,
    String fileId, {
    required String expectedUser,
    required bool Function() isCurrent,
    required ByteReadCancellation cancellation,
    int maximum = 2 * 1024 * 1024,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (maximum < 1 || maximum > 2 * 1024 * 1024) {
      throw const ApiException('INVALID_PATH', 'mobileChatFileUnavailable');
    }
    return _readFile(
      workspaceId,
      fileId,
      expectedUser: expectedUser,
      isCurrent: isCurrent,
      cancellation: cancellation,
      maximum: maximum,
      timeout: timeout,
    );
  }

  Future<FileBytes> downloadWorkspaceFile(
    String workspaceId,
    String fileId, {
    required String expectedUser,
    required bool Function() isCurrent,
    required ByteReadCancellation cancellation,
    Duration timeout = const Duration(seconds: 35),
  }) => _readFile(
    workspaceId,
    fileId,
    expectedUser: expectedUser,
    isCurrent: isCurrent,
    cancellation: cancellation,
    maximum: 10 * 1024 * 1024,
    timeout: timeout,
  );

  Future<FileBytes> _readFile(
    String workspaceId,
    String fileId, {
    required String expectedUser,
    required bool Function() isCurrent,
    required ByteReadCancellation cancellation,
    int maximum = 2 * 1024 * 1024,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final identifier = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
    if (![workspaceId, fileId, expectedUser].every(identifier.hasMatch) ||
        maximum < 1 ||
        maximum > 10 * 1024 * 1024) {
      throw const ApiException('INVALID_PATH', 'mobileChatFileUnavailable');
    }
    final stamp = generation;
    final result = await readBoundedBinary(
      this,
      '/api/workspaces/$workspaceId/files/$fileId/download',
      expectedUser: expectedUser,
      isCurrent: isCurrent,
      cancellation: cancellation,
      maximum: maximum,
      timeout: timeout,
      validateHeaders: (headers) {
        if (!(headers['content-disposition'] ?? '').toLowerCase().startsWith(
          'attachment;',
        )) {
          throw const ApiException('INVALID_FILE', 'mobileChatFileFailed');
        }
      },
    );
    guard(stamp);
    if (!isCurrent() || cancellation.cancelled) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
    return FileBytes(
      result.bytes,
      (result.headers['content-type'] ?? '')
          .split(';')
          .first
          .trim()
          .toLowerCase(),
    );
  }
}

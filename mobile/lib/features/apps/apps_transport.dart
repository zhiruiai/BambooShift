import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';

class AppsTransport {
  AppsTransport(this.scope);
  final WorkspaceController scope;
  final _cancellation = ByteReadCancellation();

  void guard() {
    scope.guard();
    if (_cancellation.cancelled) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  Future<Object?> send(String method, String suffix, {Json? body}) async {
    guard();
    if (!RegExp(r'^/apps(?:/[A-Za-z0-9_-]+)*$').hasMatch(suffix) ||
        !{'GET', 'POST', 'DELETE', 'PUT'}.contains(method) ||
        (method == 'PUT' &&
            !RegExp(r'^/apps/[A-Za-z0-9_-]+/tools/access$').hasMatch(suffix))) {
      throw const ApiException('INVALID_PATH', 'requestFailed');
    }
    if (method != 'GET' && !scope.owner) {
      throw const ApiException('FORBIDDEN', 'mobileAppsOwnerOnly', 403);
    }
    final value = await scope.requestValue(
      method,
      suffix,
      body: body,
      cancellation: _cancellation,
    );
    guard();
    return value;
  }

  void close() => _cancellation.cancel();
}

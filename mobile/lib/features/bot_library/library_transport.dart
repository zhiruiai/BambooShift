import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import 'library_data.dart';

class LibraryTransport {
  LibraryTransport(this.scope);
  final WorkspaceController scope;
  final cancellation = ByteReadCancellation();
  bool get active => scope.active && !cancellation.cancelled;
  void guard() {
    scope.guard();
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  String workspacePath(String wid, String suffix) {
    if (!libraryId(wid) || !suffix.startsWith('/')) invalidLibrary();
    return '/api/workspaces/$wid$suffix';
  }

  Future<Object?> send(String method, String path, {Json? body}) async {
    guard();
    final value = await scope.session.api.requestValue(
      method,
      path,
      body: body,
      expectedUser: scope.userId,
      isCurrent: () => active,
      cancellation: cancellation,
    );
    guard();
    return value;
  }

  Future<List<Json>> account() async {
    guard();
    await scope.session.refresh();
    guard();
    return scope.session.workspaces
        .where((w) => w['status'] == 'active')
        .toList();
  }

  Future<Json> owner(String wid, {bool personal = false}) async {
    final all = await account();
    final target = all
        .where(
          (w) =>
              w['id'] == wid &&
              w['role'] == 'owner' &&
              (!personal || w['kind'] == 'personal'),
        )
        .firstOrNull;
    if (target == null) {
      throw const ApiException('FORBIDDEN', 'mobileLibraryTargetUnavailable');
    }
    return libraryCopy(target);
  }

  void close() => cancellation.cancel();
}

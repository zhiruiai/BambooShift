import '../../core/api.dart';
import '../../core/workspace_controller.dart';

class ChatReads {
  ChatReads(this.scope, this.conversationId);
  final WorkspaceController scope;
  final String conversationId;
  int _attempted = -1;
  bool busy = false, _closed = false;
  bool get active => !_closed && scope.active;

  void retry() {
    if (active && !busy) _attempted = -1;
  }

  Future<bool> viewed(Json? rendered, bool Function() visible) async {
    if (!active || busy || !visible() || rendered?['id'] != conversationId) {
      return false;
    }
    final through = rendered?['readThrough'], unread = rendered?['unread'];
    if (through is! int ||
        through < 0 ||
        through > 9007199254740991 ||
        unread is! int ||
        unread <= 0 ||
        through <= _attempted) {
      return false;
    }
    _attempted = through;
    busy = true;
    try {
      if (!active || !visible()) return false;
      await scope.request(
        'PATCH',
        '/conversations/$conversationId',
        body: {'read': true, 'readThrough': through},
      );
      if (active && visible()) await scope.refresh();
    } catch (_) {
      // A read acknowledgement is idempotent; explicit refresh may try it again.
    } finally {
      if (active) busy = false;
    }
    return true;
  }

  void dispose() {
    _closed = true;
  }
}

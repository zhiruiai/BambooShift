import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import 'usage_data.dart';

class UsageController extends ChangeNotifier {
  UsageController(this.scope) : _owner = scope.owner {
    scope.session.addListener(_identityChanged);
  }
  final WorkspaceController scope;
  bool _owner;
  Json? data;
  String? error;
  int days = 30, _generation = 0;
  bool loading = false, _closed = false;
  bool get active => !_closed && scope.active;

  void _identityChanged() {
    if (_closed) return;
    if (!active || _owner != scope.owner) {
      _generation++;
      _owner = scope.owner;
      data = null;
      loading = false;
      error = null;
      notifyListeners();
    }
  }

  Future<void> refresh([int? selectedDays]) async {
    if (!active ||
        (selectedDays != null && ![7, 30, 90].contains(selectedDays))) {
      return;
    }
    days = selectedDays ?? days;
    final generation = ++_generation, period = days;
    final owner = scope.owner;
    loading = true;
    data = null;
    error = null;
    notifyListeners();
    try {
      final value = await scope.request('GET', '/usage?days=$period');
      if (!active || generation != _generation || owner != scope.owner) return;
      data = checkedUsage(
        value,
        scope.userId,
        scope.workspaceId,
        period,
        owner,
      );
    } catch (e) {
      if (active && generation == _generation) {
        error = e is ApiException ? e.message : 'requestFailed';
      }
    } finally {
      if (active && generation == _generation) {
        loading = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    _generation++;
    scope.session.removeListener(_identityChanged);
    super.dispose();
  }
}

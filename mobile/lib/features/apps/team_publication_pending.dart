import 'dart:convert';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import 'team_publication_data.dart';

class TeamPublicationPending {
  TeamPublicationPending(this.scope)
    : key = scope.session.api.vault.key(
        scope.session.api.server!.origin,
        'skill-publications.${scope.userId}.${scope.workspaceId}',
      );

  static const _limit = 24;
  final WorkspaceController scope;
  final String key;
  Map<String, TeamPublicationRequest> entries = {};

  void _guard() {
    if (!scope.personalOwner) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  Future<void> load() async {
    _guard();
    final raw = await scope.session.api.vault.store.read(key);
    _guard();
    if (raw != null && raw.length > 16384) {
      throw const ApiException('INVALID_PENDING', 'mobileTeamPublishStorage');
    }
    final Object? decoded = raw == null ? null : jsonDecode(raw);
    if (raw != null && decoded is! List) {
      throw const ApiException('INVALID_PENDING', 'mobileTeamPublishStorage');
    }
    final rows = decoded as List? ?? const [];
    if (rows.length > _limit) {
      throw const ApiException('INVALID_PENDING', 'mobileTeamPublishStorage');
    }
    final next = <String, TeamPublicationRequest>{};
    for (final row in rows) {
      final item = TeamPublicationRequest.parse(row);
      if (next.containsKey(item.teamId)) {
        throw const ApiException('INVALID_PENDING', 'mobileTeamPublishStorage');
      }
      next[item.teamId] = item;
    }
    entries = next;
  }

  Future<void> _write(Map<String, TeamPublicationRequest> next) async {
    _guard();
    final storage = scope.session.api.vault.store;
    if (next.isEmpty) {
      await storage.delete(key);
    } else {
      await storage.write(
        key,
        jsonEncode(next.values.map((row) => row.toJson()).toList()),
      );
    }
    _guard();
    entries = next;
  }

  Future<void> claim(TeamPublicationRequest request) =>
      scope.session.api.vault.serial(() async {
        await load();
        if (entries.containsKey(request.teamId)) {
          throw const ApiException('PENDING', 'mobileTeamPublishUnknown');
        }
        if (entries.length >= _limit) {
          throw const ApiException('PENDING_LIMIT', 'mobileTeamPublishStorage');
        }
        await _write({...entries, request.teamId: request});
      });

  Future<void> resolve(TeamPublicationRequest request) =>
      scope.session.api.vault.serial(() async {
        await load();
        if (entries[request.teamId]?.id != request.id) return;
        await _write({...entries}..remove(request.teamId));
      });
}

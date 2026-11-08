import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'private_skill_data.dart';
import 'team_publication_data.dart';
import 'team_publication_pending.dart';

class TeamPublicationController extends ChangeNotifier {
  TeamPublicationController(this.scope)
    : _pending = TeamPublicationPending(scope) {
    scope.session.addListener(_scopeChanged);
  }

  final WorkspaceController scope;
  final TeamPublicationPending _pending;
  List<TeamPublicationTarget> targets = const [];
  ({String teamId, TeamPublication publication})? confirmed;
  PrivateSkillKey? _source;
  bool busy = false;
  bool storageReady = false;
  bool _closed = false;
  String? feedback;
  final _inaccessibleReceipts = <String>{};

  bool get active => !_closed && scope.personalOwner;
  List<TeamPublicationRequest> get pending =>
      active ? List.unmodifiable(_pending.entries.values) : const [];
  bool hasTargetsFor(PrivateSkill skill) => _source == skill.key;
  bool canRemoveReminder(TeamPublicationRequest request) =>
      active && _inaccessibleReceipts.contains(request.id);

  void _scopeChanged() {
    if (active || _closed) return;
    targets = const [];
    _pending.entries = {};
    _source = null;
    confirmed = null;
    _inaccessibleReceipts.clear();
    feedback = null;
    notifyListeners();
  }

  Future<Object?> _request(String method, String path, {Json? body}) async {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    final value = await scope.requestValue(method, path, body: body);
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    return value;
  }

  Future<void> _read(PrivateSkill? skill) async {
    targets = const [];
    _source = null;
    if (skill == null || !skill.available || skill.description.trim().isEmpty) {
      return;
    }
    final value = await _request(
      'GET',
      '/private-skills/${skill.id}/team-publication-targets',
    );
    targets = publicationTargets(value);
    _source = skill.key;
  }

  Future<void> _work(Future<void> Function() operation) async {
    if (!active || busy) return;
    busy = true;
    feedback = null;
    confirmed = null;
    notifyListeners();
    try {
      await operation();
    } catch (_) {
      if (active) feedback ??= 'mobileTeamPublishLoadFailed';
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> refresh([PrivateSkill? skill]) => _work(() async {
    storageReady = false;
    try {
      await _pending.load();
      storageReady = true;
    } catch (_) {
      feedback = 'mobileTeamPublishStorage';
      return;
    }
    try {
      await _read(skill);
    } on ApiException catch (error) {
      feedback = switch (error.code) {
        'TEAM_SKILL_SOURCE_CHANGED' => 'mobileTeamPublishSourceChanged',
        'TEAM_SKILL_TEMPLATE_SOURCE' => 'mobileTeamSkillTemplateSource',
        _ when error.status == 404 => 'mobileTeamPublishUnsupported',
        _ => 'mobileTeamPublishLoadFailed',
      };
    }
  });

  bool canPublish(PrivateSkill skill, TeamPublicationTarget? target) =>
      active &&
      !busy &&
      storageReady &&
      skill.available &&
      skill.description.trim().isNotEmpty &&
      hasTargetsFor(skill) &&
      target != null &&
      targets.contains(target) &&
      !_pending.entries.containsKey(target.id) &&
      target.publication?.sourceRevision != skill.revision;

  String? _knownRejection(ApiException error) =>
      switch ((error.status, error.code)) {
        (409, 'TEAM_SKILL_SOURCE_CHANGED') => 'mobileTeamPublishSourceChanged',
        (409, 'TEAM_SKILL_REVISION' || 'TEAM_SKILL_REQUEST_CONFLICT') =>
          'mobileTeamPublishChanged',
        (409, 'TEAM_SKILL_REQUEST_CLOSED') => 'mobileTeamPublishCancelled',
        (409, 'TEAM_SKILL_CAPACITY') => 'mobileTeamSkillCapacity',
        (409, 'TEAM_SKILL_POLICY_CHANGED') => 'mobileTeamPublishPolicyChanged',
        (403, 'TEAM_SKILL_MEMBER_PUBLISHING_DISABLED') =>
          'mobileTeamPublishPolicyDisabled',
        (403, 'TEAM_SKILL_PUBLISHER_MISMATCH') =>
          'mobileTeamPublishPublisherMismatch',
        (409, 'TEAM_SKILL_MODERATED') => 'mobileTeamPublishModerated',
        (409, 'TEAM_SKILL_TEMPLATE_SOURCE') => 'mobileTeamSkillTemplateSource',
        _ => null,
      };

  Future<void> publish(PrivateSkill skill, TeamPublicationTarget target) async {
    if (!canPublish(skill, target)) return;
    await _work(() async {
      final marker = TeamPublicationRequest(
        id: requestId(),
        skillId: skill.id,
        sourceRevision: skill.revision,
        teamId: target.id,
        teamName: target.name,
      );
      try {
        await _pending.claim(marker);
      } on ApiException catch (error) {
        feedback = error.code == 'PENDING'
            ? 'mobileTeamPublishUnknown'
            : 'mobileTeamPublishStorage';
        return;
      } catch (_) {
        feedback = 'mobileTeamPublishStorage';
        return;
      }
      try {
        final value = await _request(
          'PUT',
          marker.path,
          body: {
            'requestId': marker.id,
            'expectedSourceRevision': marker.sourceRevision,
            'expectedPublicationRevision': target.publication?.revision,
            'expectedTeamPolicyRevision': ?target.policyRevision,
          },
        );
        final publication = marker.receipt(value, mayBeCancelled: false)!;
        confirmed = (teamId: marker.teamId, publication: publication);
        feedback = 'mobileTeamPublishDone';
      } on ApiException catch (error) {
        feedback = _knownRejection(error);
        if (feedback == null) {
          feedback = 'mobileTeamPublishUnknown';
          return;
        }
      } catch (_) {
        feedback = 'mobileTeamPublishUnknown';
        return;
      }
      await _settle(marker, skill);
    });
  }

  Future<void> _settle(
    TeamPublicationRequest marker,
    PrivateSkill? skill,
  ) async {
    try {
      await _pending.resolve(marker);
      _inaccessibleReceipts.remove(marker.id);
    } catch (_) {
      feedback = 'mobileTeamPublishStorage';
    }
    try {
      await _read(skill);
    } catch (_) {
      // The receipt stays authoritative if refreshing the team list fails.
    }
  }

  Future<void> recover(
    TeamPublicationRequest marker, {
    PrivateSkill? skill,
    bool cancel = false,
  }) => _work(() async {
    if (_pending.entries[marker.teamId]?.id != marker.id) return;
    try {
      final value = await _request(
        cancel ? 'DELETE' : 'GET',
        marker.receiptPath,
      );
      final result = marker.receipt(value, mayBeCancelled: true);
      if (result != null) {
        confirmed = (teamId: marker.teamId, publication: result);
      }
      feedback = result == null
          ? 'mobileTeamPublishCancelled'
          : 'mobileTeamPublishDone';
    } on ApiException catch (error) {
      if (error.status == 403 && active) {
        _inaccessibleReceipts.add(marker.id);
        feedback = 'mobileTeamPublishReceiptForbidden';
      } else {
        _inaccessibleReceipts.remove(marker.id);
        feedback = error.code == 'TEAM_SKILL_PUBLICATION_NOT_FOUND'
            ? 'mobileTeamPublishNotFound'
            : 'mobileTeamPublishUnknown';
      }
      return;
    } catch (_) {
      _inaccessibleReceipts.remove(marker.id);
      feedback = 'mobileTeamPublishUnknown';
      return;
    }
    await _settle(marker, skill);
  });

  Future<void> removeReminder(
    TeamPublicationRequest marker, {
    PrivateSkill? skill,
  }) => _work(() async {
    if (canRemoveReminder(marker) &&
        _pending.entries[marker.teamId]?.id == marker.id) {
      feedback = 'mobileTeamPublishReminderRemoved';
      await _settle(marker, skill);
    }
  });

  @override
  void dispose() {
    _closed = true;
    scope.session.removeListener(_scopeChanged);
    super.dispose();
  }
}

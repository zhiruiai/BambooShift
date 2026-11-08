import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

typedef _Policy = ({bool memberPublishing, String revision});

class TeamSkillPolicyScreen extends StatefulWidget {
  const TeamSkillPolicyScreen({super.key, required this.scope});

  final WorkspaceController scope;

  @override
  State<TeamSkillPolicyScreen> createState() => _TeamSkillPolicyScreenState();
}

class _TeamSkillPolicyScreenState extends State<TeamSkillPolicyScreen> {
  static const _path = '/team-skills/publishing-policy';
  _Policy? _saved;
  String? _notice;
  bool _draft = false, _busy = false;

  bool get _active =>
      mounted &&
      widget.scope.active &&
      widget.scope.owner &&
      widget.scope.session.workspace?['kind'] == 'team';

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<_Policy> _request(String method, {Json? body}) async {
    if (!_active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    final value = await widget.scope.request(method, _path, body: body);
    if (!_active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    final revision = value['revision'];
    final enabled = value['memberPublishing'];
    if (enabled is! bool ||
        (revision != 'unset' && !isRequestId(revision)) ||
        (revision == 'unset' && enabled)) {
      throw const ApiException('INVALID_RESPONSE', 'requestFailed');
    }
    return (memberPublishing: enabled, revision: revision as String);
  }

  void _apply(_Policy policy) {
    _saved = policy;
    _draft = policy.memberPublishing;
  }

  Future<void> _refresh() => _work(() async {
    _saved = null;
    try {
      _apply(await _request('GET'));
    } catch (error) {
      _notice = error is ApiException && error.status == 404
          ? 'mobileTeamSkillPolicyUnsupported'
          : 'requestFailed';
    }
  });

  Future<void> _save() async {
    final reviewed = _saved;
    final desired = _draft;
    if (reviewed == null || reviewed.memberPublishing == desired) return;
    await _work(() async {
      try {
        final result = await _request(
          'PUT',
          body: {
            'memberPublishing': desired,
            'expectedRevision': reviewed.revision,
          },
        );
        if (result.memberPublishing != desired ||
            result.revision == reviewed.revision) {
          throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
        }
        _apply(result);
        _notice = 'mobileTeamSkillPolicySaved';
      } catch (error) {
        _saved = null;
        final conflict =
            error is ApiException &&
            error.status == 409 &&
            error.code == 'TEAM_SKILL_POLICY_CHANGED';
        _notice = conflict
            ? 'mobileTeamPublishPolicyChanged'
            : 'mobileTeamSkillPolicyUnknown';
        try {
          _apply(await _request('GET'));
          if (!conflict) _notice = 'mobileTeamSkillPolicyChecked';
        } catch (_) {
          // A failed read leaves the policy read-only until refreshed.
        }
      }
    });
  }

  Future<void> _work(Future<void> Function() action) async {
    if (!_active || _busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      await action();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.scope.session,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        title: Text(context.tr('mobileTeamSkillPolicyTitle')),
        actions: [
          IconButton(
            tooltip: context.tr('refresh'),
            onPressed: _active && !_busy ? _refresh : null,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: !_active
          ? const Notice('scopeChanged')
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(context.tr('mobileTeamSkillPolicyHelp')),
                if (_busy) const LinearProgressIndicator(),
                if (_notice case final notice?) Notice(notice),
                if (_saved != null)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(context.tr('mobileTeamSkillPolicyAllow')),
                    value: _draft,
                    onChanged: _busy
                        ? null
                        : (value) => setState(() => _draft = value),
                  ),
              ],
            ),
      bottomNavigationBar: !_active || _saved == null
          ? null
          : SafeArea(
              top: false,
              minimum: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: FilledButton(
                onPressed: _busy || _saved?.memberPublishing == _draft
                    ? null
                    : _save,
                child: Text(context.tr('save')),
              ),
            ),
    ),
  );
}

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'team_skill_link.dart';

typedef _Target = ({
  String agentId,
  String agentName,
  String? workspaceId,
  String? workspaceName,
});

String _targetKey(_Target target) => target.workspaceId == null
    ? target.agentId
    : "${target.workspaceId}/${target.agentId}";

class TeamSkillsScreen extends StatefulWidget {
  const TeamSkillsScreen({
    super.key,
    required this.scope,
    required this.sourceAgentId,
  });

  final WorkspaceController scope;
  final String sourceAgentId;

  @override
  State<TeamSkillsScreen> createState() => _TeamSkillsScreenState();
}

class _TeamSkillsScreenState extends State<TeamSkillsScreen> {
  WorkspaceController get scope => widget.scope;
  bool get active =>
      mounted && scope.active && scope.session.workspace?['kind'] == 'team';
  bool busy = false;
  String? error, target;
  _Target? imported;
  List<Json>? items;
  List<_Target> personalTargets = [];

  @override
  void initState() {
    super.initState();
    unawaited(_work(_read));
  }

  Future<void> _work(
    Future<void> Function() action, {
    bool owner = false,
  }) async {
    if (!active || busy || (owner && !scope.owner)) return;
    setState(() {
      busy = true;
      error = null;
      imported = null;
    });
    try {
      await action();
    } catch (cause) {
      if (active) {
        setState(() {
          error = switch (cause) {
            ApiException(code: 'TEAM_SKILL_REVISION') =>
              'mobileTeamSkillRevision',
            ApiException(code: 'TEAM_SKILL_SOURCE_REQUIRED') =>
              'mobileTeamSkillSourceChanged',
            ApiException(code: 'TEAM_SKILL_CAPACITY') =>
              'mobileTeamSkillCapacity',
            ApiException(code: 'TEAM_SKILL_PERSONAL_TARGET') =>
              'mobileTeamSkillPersonalTarget',
            ApiException(code: 'TEAM_SKILL_TEMPLATE_SOURCE') =>
              'mobileTeamSkillTemplateSource',
            ApiException(code: 'TEAM_SKILL_PUBLISHER_MISMATCH') =>
              'mobileTeamPublishPublisherMismatch',
            ApiException() => cause.message,
            _ => 'requestFailed',
          };
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  bool _validPublication(Object? value) =>
      value is Json &&
      isRequestId(value['id']) &&
      isRequestId(value['revision']) &&
      (value['linkId'] == null || isTeamSkillLinkId(value['linkId'])) &&
      (value['canWithdraw'] == null || value['canWithdraw'] is bool) &&
      (value['canModerate'] == null || value['canModerate'] is bool) &&
      value['version'] is int &&
      value['name'] is String &&
      value['description'] is String &&
      value['content'] is String &&
      _validSource(value['source']);

  bool _validSource(Object? source) {
    if (source is! Json) return false;
    if (source['origin'] == 'personal') {
      return source.keys.every((key) => key == 'origin' || key == 'version') &&
          source['version'] is int &&
          source['version'] > 0;
    }
    return source['agentId'] is String &&
        source['agentName'] is String &&
        source['skillId'] is String &&
        (source['skillId'] as String).isNotEmpty;
  }

  Future<void> _read() async {
    final value = await scope.requestValue('GET', '/team-skills');
    if (value is! List ||
        value.length > 80 ||
        !value.every(_validPublication)) {
      throw const ApiException('INVALID_TEAM_SKILLS', 'requestFailed');
    }
    if (!active) return;
    try {
      await _readPersonalTargets();
    } finally {
      if (active) setState(() => items = value.cast<Json>());
    }
  }

  Future<void> _readPersonalTargets() async {
    final workspaces = await scope.requestValue(
      'GET',
      '/team-skills/import-targets',
    );
    if (workspaces is! List) {
      throw const ApiException('INVALID_TEAM_SKILLS', 'requestFailed');
    }
    final targets = <_Target>[];
    for (final workspace in workspaces) {
      if (workspace is! Json ||
          !isRequestId(workspace['workspaceId']) ||
          workspace['workspaceName'] is! String ||
          workspace['agents'] is! List) {
        throw const ApiException('INVALID_TEAM_SKILLS', 'requestFailed');
      }
      for (final agent in workspace['agents']) {
        if (agent is! Json ||
            agent['id'] is! String ||
            agent['name'] is! String) {
          throw const ApiException('INVALID_TEAM_SKILLS', 'requestFailed');
        }
        targets.add((
          workspaceId: workspace['workspaceId'] as String,
          workspaceName: workspace['workspaceName'] as String,
          agentId: agent['id'] as String,
          agentName: agent['name'] as String,
        ));
      }
    }
    if (active) setState(() => personalTargets = targets);
  }

  Future<void> _publish(Json skill, Json? prior) async {
    if (!active || busy || !scope.owner) return;
    final label = context.tr(
      prior == null ? 'mobileTeamSkillPublish' : 'mobileTeamSkillSync',
    );
    final agreed = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(skill['name'] as String),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(context.tr('mobileTeamSkillPublishHelp')),
              const SizedBox(height: 12),
              Text(skill['description'] as String),
              const SizedBox(height: 8),
              SelectableText(skill['content'] as String),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: Text(context.tr('cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: Text(label),
          ),
        ],
      ),
    );
    if (!active || agreed != true) return;
    await _work(() async {
      final live = scope.find('skills', skill['id'] as String);
      if (live?['status'] != 'active' || live?['teamSource'] != null) {
        throw const ApiException(
          'TEAM_SKILL_SOURCE_REQUIRED',
          'mobileTeamSkillSourceChanged',
        );
      }
      final result = await scope.request(
        'POST',
        '/team-skills',
        body: {'skillId': skill['id'], 'expectedRevision': prior?['revision']},
      );
      if (!_validPublication(result) ||
          result['source']['skillId'] != skill['id']) {
        throw const ApiException('INVALID_TEAM_SKILLS', 'requestUnknown');
      }
      if (active) {
        setState(() {
          items = [
            result,
            ...?items?.where((item) => item['id'] != result['id']),
          ];
        });
      }
    }, owner: true);
  }

  Future<void> _withdraw(Json item) async {
    if (!active || busy || !_canWithdraw(item)) return;
    final help = _canModerate(item)
        ? 'mobileTeamSkillModerateHelp'
        : 'mobileTeamSkillWithdrawHelp';
    if (!await confirm(context, help) || !active || !_canWithdraw(item)) return;
    await _work(() async {
      try {
        final result = await scope.request(
          'POST',
          '/team-skills/${item['id']}/unpublish',
          body: {'expectedRevision': item['revision']},
        );
        if (result['ok'] != true) {
          throw const ApiException('INVALID_TEAM_SKILLS', 'requestUnknown');
        }
      } catch (_) {
        if (active) {
          setState(() => items = null);
          try {
            await _read();
          } catch (_) {
            // Keep the stale action hidden until the catalog can be read.
          }
        }
        rethrow;
      }
      if (active) {
        setState(
          () => items?.removeWhere((value) => value['id'] == item['id']),
        );
      }
    });
  }

  bool _canWithdraw(Json item) => item['canWithdraw'] as bool? ?? scope.owner;
  bool _canModerate(Json item) => scope.owner && item['canModerate'] == true;

  Future<void> _import(Json item, _Target destination) => _work(() async {
    final agentId = destination.agentId;
    final workspaceId = destination.workspaceId;
    if (workspaceId == null) {
      final agent = scope.find('agents', agentId);
      if (!scope.owner ||
          agent == null ||
          isManagedBot(agent) ||
          item['source']['agentId'] == agentId) {
        return;
      }
    }
    final result = await scope.request(
      'POST',
      '/team-skills/${item['id']}/import',
      body: {
        'agentId': agentId,
        'expectedRevision': item['revision'],
        'targetWorkspaceId': ?workspaceId,
      },
    );
    if (result['agentId'] != agentId ||
        result['teamSource']?['id'] != item['id'] ||
        result['teamSource']?['revision'] != item['revision']) {
      throw const ApiException('INVALID_TEAM_SKILLS', 'requestUnknown');
    }
    if (workspaceId != null) {
      if (active) setState(() => imported = destination);
      return;
    }
    await scope.refresh();
    if (mounted && active) Navigator.pop(context, agentId);
  });

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([scope, scope.session]),
    builder: (context, _) {
      final agents = scope
          .items('agents')
          .where((agent) => !isManagedBot(agent))
          .toList();
      final targets = <_Target>[
        if (scope.owner)
          for (final agent in agents)
            (
              workspaceId: null,
              workspaceName: null,
              agentId: agent['id'] as String,
              agentName: agent['name'] as String,
            ),
        ...personalTargets,
      ];
      final selected = targets
          .where((candidate) => _targetKey(candidate) == target)
          .firstOrNull;
      final source = scope
          .items('skills')
          .where(
            (skill) =>
                skill['agentId'] == widget.sourceAgentId &&
                skill['status'] == 'active' &&
                skill['teamSource'] == null &&
                (skill['description'] as String? ?? '').trim().isNotEmpty &&
                agents.any((agent) => agent['id'] == widget.sourceAgentId),
          );
      return Scaffold(
        appBar: AppBar(
          title: Text(context.tr('mobileTeamSkillTitle')),
          actions: [
            IconButton(
              tooltip: context.tr('refresh'),
              icon: const Icon(Icons.refresh),
              onPressed: busy || !active ? null : () => _work(_read),
            ),
          ],
        ),
        body: !active
            ? const Notice('scopeChanged')
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Text(context.tr('mobileTeamSkillHelp')),
                  if (busy) const LinearProgressIndicator(),
                  if (error != null) Notice(error!),
                  if (imported case final destination?)
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        "${destination.workspaceName} · ${destination.agentName}\n"
                        "${context.tr('mobileTeamSkillPersonalImported')}",
                      ),
                    ),
                  if (targets.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      key: ValueKey(
                        selected == null ? null : _targetKey(selected),
                      ),
                      isExpanded: true,
                      initialValue: selected == null
                          ? null
                          : _targetKey(selected),
                      decoration: InputDecoration(
                        labelText: context.tr('mobileTeamSkillTarget'),
                      ),
                      items: [
                        for (final destination in targets)
                          DropdownMenuItem(
                            value: _targetKey(destination),
                            child: Text(
                              destination.workspaceName == null
                                  ? destination.agentName
                                  : "${destination.workspaceName} · ${destination.agentName}",
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                      onChanged: busy
                          ? null
                          : (value) => setState(() => target = value),
                    ),
                  ],
                  if (items?.isEmpty == true)
                    const Notice('mobileTeamSkillEmpty'),
                  for (final item in items ?? const <Json>[])
                    _published(item, selected),
                  if (scope.owner && items != null && source.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    Text(context.tr('mobileTeamSkillSources')),
                    for (final skill in source) _source(skill),
                  ],
                ],
              ),
      );
    },
  );

  Widget _published(Json item, _Target? destination) {
    final canImport =
        destination != null &&
        (destination.workspaceId != null ||
            (scope.owner && destination.agentId != item['source']['agentId']));
    return Card(
      key: ValueKey(item['id']),
      child: ExpansionTile(
        title: Text(item['name'] as String),
        subtitle: Text(
          "v${item['version']} · ${item['source']['origin'] == 'personal' ? context.tr('mobileTeamPublishPersonalOrigin') : item['source']['agentName']}",
        ),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(item['description'] as String),
          const SizedBox(height: 8),
          SelectableText(item['content'] as String),
          Wrap(
            spacing: 8,
            children: [
              if (scope.owner || personalTargets.isNotEmpty)
                OutlinedButton(
                  onPressed: busy || !canImport
                      ? null
                      : () => _import(item, destination),
                  child: Text(context.tr('mobileTeamSkillImport')),
                ),
              TeamSkillLinkButton(
                scope: scope,
                teamId: scope.workspaceId,
                publicationId: item['id'],
                linkId: item['linkId'],
                enabled: !busy,
              ),
              if (_canWithdraw(item))
                TextButton(
                  onPressed: busy ? null : () => _withdraw(item),
                  child: Text(
                    context.tr(
                      _canModerate(item)
                          ? 'mobileTeamSkillModerate'
                          : 'mobileTeamSkillWithdraw',
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _source(Json skill) {
    final prior = items
        ?.where(
          (item) =>
              item['source']['agentId'] == skill['agentId'] &&
              item['name'] == skill['name'],
        )
        .firstOrNull;
    final published = prior?['source']['skillId'] == skill['id'];
    return Card(
      key: ValueKey(skill['id']),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(skill['name'] as String),
            Text("v${skill['version']}"),
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(
                onPressed: busy || published
                    ? null
                    : () => _publish(skill, prior),
                child: Text(
                  context.tr(
                    published
                        ? 'mobileTeamSkillPublished'
                        : prior == null
                        ? 'mobileTeamSkillPublish'
                        : 'mobileTeamSkillSync',
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

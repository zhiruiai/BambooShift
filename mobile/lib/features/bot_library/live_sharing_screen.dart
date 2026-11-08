import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'live_sharing_controller.dart';

class LiveSharingScreen extends StatefulWidget {
  const LiveSharingScreen({
    super.key,
    required this.scope,
    required this.agentId,
  });
  final WorkspaceController scope;
  final String agentId;
  @override
  State<LiveSharingScreen> createState() => _LiveSharingScreenState();
}

class _LiveSharingScreenState extends State<LiveSharingScreen> {
  late final LiveSharingController c;
  bool leaving = false;
  @override
  void initState() {
    super.initState();
    c = LiveSharingController(widget.scope, widget.agentId);
    unawaited(c.initialize());
  }

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  Future<void> leave() async {
    if (c.busy) return;
    if ((c.dirty || c.unknown) &&
        !await confirm(
          context,
          c.unknown ? 'mobileLibraryLeavePending' : 'mobileLibraryEditDiscard',
        )) {
      return;
    }
    if (mounted) {
      setState(() => leaving = true);
      Navigator.pop(context);
    }
  }

  Future<void> save({bool revoke = false}) async {
    if (await confirm(
          context,
          revoke
              ? 'mobileLibraryLiveRevokeConfirm'
              : 'mobileLibraryLiveSaveConfirm',
        ) &&
        mounted &&
        c.active) {
      await c.save(revoke: revoke);
    }
  }

  Widget title(String key) => Padding(
    padding: const EdgeInsets.only(top: 20, bottom: 8),
    child: Text(context.tr(key), style: Theme.of(context).textTheme.titleLarge),
  );
  Widget selectedFile(Json f) => Card(
    child: ListTile(
      title: Text(f['name']),
      subtitle: Text(
        '${f['size']} B · ${context.tr('mobileLibraryGrant_${f['status'] ?? 'available'}')}',
      ),
      trailing: IconButton(
        tooltip: context.tr('mobileLibraryRemoveItem'),
        icon: const Icon(Icons.remove_circle_outline),
        onPressed: c.locked ? null : () => c.selectFile(f, false),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: c,
    builder: (context, _) => PopScope(
      canPop: leaving,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(leave());
      },
      child: Scaffold(
        appBar: AppBar(title: Text(context.tr('mobileLibraryLiveSharing'))),
        body: !c.active
            ? const Notice('scopeChanged')
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  const Notice('mobileLibraryLiveHint'),
                  if (c.busy) const LinearProgressIndicator(),
                  if (c.error != null) Notice(c.error!),
                  if (c.unknown) ...[
                    const Notice('mobileLibraryLiveUnknown'),
                    OutlinedButton(
                      onPressed: c.busy ? null : c.refresh,
                      child: Text(context.tr('checkResult')),
                    ),
                    TextButton(
                      onPressed: c.busy
                          ? null
                          : () async {
                              if (await confirm(
                                    context,
                                    'mobileLibraryPolicyAcknowledgeConfirm',
                                  ) &&
                                  mounted &&
                                  c.active) {
                                await c.acknowledge();
                              }
                            },
                      child: Text(
                        context.tr('mobileLibraryAcknowledgeCurrent'),
                      ),
                    ),
                  ],
                  if (c.snapshot != null) ...[
                    Text(
                      context.tr(
                        c.share?['status'] == 'active'
                            ? 'mobileLibraryLiveActive'
                            : 'mobileLibraryLiveInactive',
                      ),
                    ),
                    if (c.teams.isEmpty) const Notice('mobileLibraryNoTeams'),
                    if (c.teams.isNotEmpty)
                      DropdownButtonFormField<String>(
                        key: ValueKey('team:${c.teamId}'),
                        initialValue: c.team == null ? null : c.teamId,
                        isExpanded: true,
                        decoration: InputDecoration(
                          labelText: context.tr('mobileLibraryTargetTeam'),
                        ),
                        items: [
                          for (final t in c.teams)
                            DropdownMenuItem(
                              value: t['id'] as String,
                              child: Text(t['name']),
                            ),
                        ],
                        onChanged: c.locked
                            ? null
                            : (v) {
                                if (v != null) c.chooseTeam(v);
                              },
                      ),
                    DropdownButtonFormField<String>(
                      initialValue: c.audience,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileLibraryLiveAudience'),
                      ),
                      items: [
                        for (final a in ['team', 'selected'])
                          DropdownMenuItem(
                            value: a,
                            child: Text(
                              context.tr('mobileLibraryLiveAudience_$a'),
                            ),
                          ),
                      ],
                      onChanged: c.locked
                          ? null
                          : (v) {
                              if (v != null) c.chooseAudience(v);
                            },
                    ),
                    if (c.audience == 'selected' && c.team != null)
                      for (final m in c.team!['members'])
                        CheckboxListTile(
                          title: Text(m['name']),
                          value: c.members.contains(m['userId']),
                          onChanged: c.locked
                              ? null
                              : (v) => c.member(m['userId'], v == true),
                        ),
                    title('mobileLibrarySharedFiles'),
                    const Notice('mobileLibraryGrantHint'),
                    for (final f in c.selectedFiles) selectedFile(f),
                    TextFormField(
                      initialValue: c.query,
                      enabled: !c.locked,
                      maxLength: 120,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileLibraryFileSearch'),
                      ),
                      onChanged: (v) => c.query = v,
                    ),
                    OutlinedButton(
                      onPressed: c.locked || c.dirty ? null : c.refresh,
                      child: Text(context.tr('mobileLibraryFindFiles')),
                    ),
                    if (c.truncated)
                      const Notice('mobileLibraryFilesTruncated'),
                    for (final f in c.files)
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Text(f['name']),
                              Text('${f['size']} B · ${f['type']}'),
                              if (f['revision'] != null) ...[
                                SelectableText(f['revision']),
                                OutlinedButton(
                                  onPressed: c.locked
                                      ? null
                                      : () => c.selectFile(f, true),
                                  child: Text(
                                    context.tr(
                                      'mobileLibrarySelectFileVersion',
                                    ),
                                  ),
                                ),
                              ] else
                                OutlinedButton(
                                  onPressed: c.locked
                                      ? null
                                      : () => c.inspectFile(f['fileId']),
                                  child: Text(
                                    context.tr('mobileLibraryInspectFile'),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                    title('mobileLibrarySharedApps'),
                    for (final a in c.selectedApps)
                      Card(
                        child: ListTile(
                          title: Text(a['name']),
                          subtitle: Text(
                            '${(a['tools'] as List).map((t) => t['name']).join(', ')}\n${context.tr('mobileLibraryGrant_${a['status'] ?? 'available'}')}',
                          ),
                          trailing: IconButton(
                            tooltip: context.tr('mobileLibraryRemoveItem'),
                            icon: const Icon(Icons.remove_circle_outline),
                            onPressed: c.locked
                                ? null
                                : () => c.removeApp(a['connectionId']),
                          ),
                        ),
                      ),
                    for (final a in c.apps)
                      Card(
                        child: ListTile(
                          title: Text(a['name']),
                          subtitle: Text(
                            '${a['toolCount']} ${context.tr('mobileLibraryTools')}',
                          ),
                          trailing: OutlinedButton(
                            onPressed: c.locked || a['status'] != 'connected'
                                ? null
                                : () => c.inspectApp(a['connectionId']),
                            child: Text(
                              context.tr('mobileLibraryInspectTools'),
                            ),
                          ),
                        ),
                      ),
                    if (c.inspectedApp != null) ...[
                      Text(
                        c.inspectedApp!['name'],
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const Notice('mobileLibraryToolReviewHint'),
                      for (final t in c.inspectedApp!['tools'])
                        Card(
                          child: Column(
                            children: [
                              CheckboxListTile(
                                title: Text(t['name']),
                                subtitle: Text(t['description']),
                                value: c.tools.contains(t['name']),
                                onChanged: c.locked
                                    ? null
                                    : (v) => c.tool(t['name'], v == true),
                              ),
                              ExpansionTile(
                                title: Text(
                                  context.tr('mobileLibraryToolInputs'),
                                ),
                                children: [
                                  Padding(
                                    padding: const EdgeInsets.all(12),
                                    child: SelectableText(
                                      const JsonEncoder.withIndent(
                                        '  ',
                                      ).convert(t['inputSchema']),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      OutlinedButton(
                        onPressed: c.locked || c.tools.isEmpty
                            ? null
                            : c.selectApp,
                        child: Text(context.tr('mobileLibrarySelectTools')),
                      ),
                    ],
                    const SizedBox(height: 20),
                    FilledButton(
                      onPressed:
                          c.locked ||
                              !c.dirty ||
                              c.team == null ||
                              (c.audience == 'selected' && c.members.isEmpty)
                          ? null
                          : save,
                      child: Text(context.tr('save')),
                    ),
                    if (c.share?['status'] == 'active')
                      TextButton(
                        onPressed: c.locked ? null : () => save(revoke: true),
                        child: Text(context.tr('mobileLibraryLiveRevoke')),
                      ),
                  ],
                ],
              ),
      ),
    ),
  );
}

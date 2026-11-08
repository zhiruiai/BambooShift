import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

class TeamSettings extends StatefulWidget {
  const TeamSettings({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<TeamSettings> createState() => _TeamSettingsState();
}

class _TeamSettingsState extends State<TeamSettings> {
  Json? data;
  String? error;
  bool busy = false;
  String get path => '/api/account/workspaces/${widget.scope.workspaceId}';
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<Json> request(String method, String suffix, {Json? body}) async {
    widget.scope.guard();
    final result = await widget.scope.session.api.request(
      method,
      '$path$suffix',
      body: body,
      expectedUser: widget.scope.userId,
    );
    widget.scope.guard();
    return result;
  }

  Future<void> _load() async {
    try {
      final value = await request('GET', '/team');
      if (mounted) {
        setState(() {
          data = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    }
  }

  Future<void> _invite() async {
    if (busy) return;
    setState(() => busy = true);
    try {
      final result = await request('POST', '/invitations');
      if (!mounted || !widget.scope.active) return;
      final token = result['token'];
      if (token is! String) {
        throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
      }
      await _load();
      if (!mounted || !widget.scope.active) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(context.tr('invitation')),
          content: SelectableText(token, style: const TextStyle(fontSize: 14)),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(context.tr('close')),
            ),
            FilledButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: token));
                if (context.mounted) {
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text(context.tr('copied'))));
                }
              },
              child: Text(context.tr('copy')),
            ),
          ],
        ),
      );
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _remove(String userId) async {
    if (busy || !await confirm(context, 'removeConfirm')) return;
    if (!mounted || !widget.scope.active) return;
    setState(() => busy = true);
    try {
      await request('DELETE', '/members/$userId');
      await widget.scope.session.refresh();
      if (widget.scope.active) await _load();
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _revoke(String id) async {
    if (busy || !await confirm(context, 'revokeInvitation')) return;
    if (!mounted || !widget.scope.active) return;
    setState(() => busy = true);
    try {
      await request('DELETE', '/invitations/$id');
      await _load();
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(context.tr('members'))),
    body: RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (error != null) Notice(error!, action: 'refresh', onAction: _load),
          for (final member
              in (data?['members'] as List? ?? []).whereType<Json>())
            Card(
              child: ListTile(
                title: Text(member['name'] as String? ?? ''),
                subtitle: Text(
                  '${member['email'] ?? ''} · ${context.tr(member['role'] as String? ?? 'member')}',
                ),
                trailing:
                    member['role'] != 'owner' &&
                        (widget.scope.owner ||
                            member['userId'] == widget.scope.userId)
                    ? IconButton(
                        tooltip: context.tr(
                          member['userId'] == widget.scope.userId
                              ? 'leaveTeam'
                              : 'removeMember',
                        ),
                        onPressed: busy
                            ? null
                            : () => _remove(member['userId'] as String),
                        icon: const Icon(Icons.person_remove_outlined),
                      )
                    : null,
              ),
            ),
          if (widget.scope.owner)
            Padding(
              padding: const EdgeInsets.only(top: 20),
              child: FilledButton.icon(
                onPressed: busy ? null : _invite,
                icon: const Icon(Icons.person_add_outlined),
                label: Text(context.tr('inviteMember')),
              ),
            ),
          if (widget.scope.owner)
            for (final invite
                in (data?['invitations'] as List? ?? [])
                    .whereType<Json>()
                    .where((v) => v['status'] == 'pending'))
              Card(
                child: ListTile(
                  title: Text(context.tr('invitationPending')),
                  subtitle: Text(invite['expiresAt'] as String? ?? ''),
                  trailing: IconButton(
                    tooltip: context.tr('revokeInvitation'),
                    onPressed: busy
                        ? null
                        : () => _revoke(invite['id'] as String),
                    icon: const Icon(Icons.close),
                  ),
                ),
              ),
        ],
      ),
    ),
  );
}

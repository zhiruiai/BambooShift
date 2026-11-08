import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/app_session.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

class AccountSettings extends StatefulWidget {
  const AccountSettings({super.key, required this.session});
  final AppSession session;
  @override
  State<AccountSettings> createState() => _AccountSettingsState();
}

class _AccountSettingsState extends State<AccountSettings> {
  late final String userId;
  late final int stamp;
  final name = TextEditingController();
  final currentPassword = TextEditingController();
  final newPassword = TextEditingController();
  List<Json> sessions = [];
  bool busy = false;
  String? error;
  bool get active =>
      mounted &&
      widget.session.userId == userId &&
      widget.session.api.generation == stamp;
  @override
  void initState() {
    super.initState();
    userId = widget.session.userId!;
    stamp = widget.session.api.generation;
    name.text = widget.session.user?['name'] as String? ?? '';
    unawaited(_read());
  }

  @override
  void dispose() {
    name.dispose();
    currentPassword.dispose();
    newPassword.dispose();
    super.dispose();
  }

  void _guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  Future<Json> request(String method, String path, {Json? body}) async {
    _guard();
    final value = await widget.session.api.request(
      method,
      path,
      body: body,
      expectedUser: userId,
    );
    _guard();
    return value;
  }

  Future<void> _read() async {
    try {
      final value = await request('GET', '/api/account/sessions');
      if (value['userId'] != userId) {
        throw const ApiException('INVALID_RESPONSE', 'requestFailed');
      }
      if (active) {
        setState(
          () => sessions = (value['sessions'] as List? ?? [])
              .whereType<Json>()
              .toList(),
        );
      }
    } catch (e) {
      if (active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    }
  }

  Future<void> _work(Future<void> Function() action) async {
    if (busy || !active) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
    } catch (e) {
      if (active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (active) setState(() => busy = false);
    }
  }

  Future<void> _save() => _work(() async {
    if (name.text.trim().isEmpty) {
      throw const ApiException('INVALID_NAME', 'required');
    }
    await request(
      'PATCH',
      '/api/account/profile',
      body: {'expectedUserId': userId, 'name': name.text.trim()},
    );
    await widget.session.refresh();
  });
  Future<void> _password() async {
    if (busy || !active) return;
    if (newPassword.text.length < 10 ||
        newPassword.text.length > 128 ||
        currentPassword.text.isEmpty) {
      setState(() => error = 'passwordHint');
      return;
    }
    if (!await confirm(context, 'passwordChangeConfirm')) return;
    await _work(() async {
      await request(
        'POST',
        '/api/account/password',
        body: {
          'expectedUserId': userId,
          'currentPassword': currentPassword.text,
          'newPassword': newPassword.text,
        },
      );
      currentPassword.clear();
      newPassword.clear();
      await widget.session.refresh();
    });
  }

  Future<void> _revoke(Json item) async {
    if (busy || !await confirm(context, 'revokeSessionConfirm')) return;
    await _work(() async {
      await request(
        'DELETE',
        '/api/account/sessions/${item['id']}',
        body: {'expectedUserId': userId},
      );
      await widget.session.refresh();
      if (active) await _read();
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(context.tr('account'))),
    body: RefreshIndicator(
      onRefresh: _read,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            widget.session.user?['email'] as String? ?? '',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 20),
          if (error != null) Notice(error!),
          TextField(
            controller: name,
            enabled: !busy,
            maxLength: 60,
            decoration: InputDecoration(labelText: context.tr('name')),
          ),
          FilledButton(
            onPressed: busy ? null : _save,
            child: Text(context.tr('save')),
          ),
          const SizedBox(height: 32),
          Text(
            context.tr('changePassword'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 16),
          TextField(
            controller: currentPassword,
            enabled: !busy,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            maxLength: 128,
            decoration: InputDecoration(
              labelText: context.tr('currentPassword'),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: newPassword,
            enabled: !busy,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            maxLength: 128,
            decoration: InputDecoration(
              labelText: context.tr('newPassword'),
              helperText: context.tr('passwordHint'),
            ),
          ),
          OutlinedButton(
            onPressed: busy ? null : _password,
            child: Text(context.tr('changePassword')),
          ),
          const SizedBox(height: 32),
          Text(
            context.tr('sessions'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 12),
          for (final item in sessions)
            Card(
              child: ListTile(
                title: Text(item['name'] as String? ?? ''),
                subtitle: Text(
                  '${item['createdAt'] ?? ''}${item['current'] == true ? ' · ${context.tr('thisDevice')}' : ''}',
                ),
                trailing: IconButton(
                  tooltip: context.tr('revokeSession'),
                  onPressed: busy ? null : () => _revoke(item),
                  icon: const Icon(Icons.logout),
                ),
              ),
            ),
        ],
      ),
    ),
  );
}

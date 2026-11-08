import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import '../../widgets/common.dart';

class PrimarySettings extends StatefulWidget {
  const PrimarySettings({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<PrimarySettings> createState() => _PrimarySettingsState();
}

class _PrimarySettingsState extends State<PrimarySettings> {
  Json? saved;
  String? selected;
  bool checkIn = false;
  String time = '09:00';
  String zone = 'Asia/Shanghai';
  bool busy = false;
  bool unknown = false;
  String? error;
  @override
  void initState() {
    super.initState();
    unawaited(_read());
  }

  Future<void> _read({bool replace = true}) async {
    try {
      final result = await widget.scope.request('GET', '/primary-bot');
      if (!mounted) return;
      setState(() {
        saved = result;
        if (replace) {
          selected = result['agentId'] as String?;
          checkIn = selected != null && result['checkIn']?['enabled'] == true;
          time = result['checkIn']?['time'] as String? ?? '09:00';
          zone = result['checkIn']?['timeZone'] as String? ?? 'Asia/Shanghai';
          unknown = false;
          error = null;
        }
      });
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    }
  }

  Future<void> _save(bool clear) async {
    if (busy || saved == null || unknown || (!clear && selected == null)) {
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.scope.request(
        'PUT',
        '/primary-bot',
        body: {
          'mode': clear ? 'clear' : 'select',
          'expectedRevision': saved!['revision'],
          if (!clear) ...{
            'agentId': selected,
            'checkIn': {'enabled': checkIn, 'time': time, 'timeZone': zone},
          },
        },
      );
      await widget.scope.refresh();
      if (mounted && widget.scope.active) Navigator.pop(context);
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() {
          error = e is ApiException ? e.message : 'requestFailed';
          unknown = e is! ApiException || e.status == 0 || e.status >= 500;
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _reload() async {
    if (await confirm(context, 'loadCurrent')) await _read();
  }

  @override
  Widget build(BuildContext context) {
    final bots = widget.scope
        .items('agents')
        .where((a) => !a.containsKey('sharedBot'))
        .toList();
    final allowed = widget.scope.owner && saved?['available'] == true;
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('primaryBot'))),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (error != null)
            Notice(error!, action: 'refresh', onAction: busy ? null : _reload),
          if (unknown) const Notice('requestUnknown'),
          if (saved == null && error == null)
            const Center(child: CircularProgressIndicator()),
          if (saved != null && !allowed) const Notice('readOnly'),
          for (final bot in bots)
            Card(
              child: ListTile(
                leading: BotAvatar(
                  bot: bot,
                  family: widget.scope.session.avatarTheme,
                ),
                title: Text(bot['name'] as String? ?? ''),
                subtitle: Text(bot['role'] as String? ?? ''),
                trailing: selected == bot['id']
                    ? const Icon(Icons.check_circle)
                    : null,
                onTap: allowed && !busy && !unknown
                    ? () => setState(() => selected = bot['id'] as String)
                    : null,
              ),
            ),
          const SizedBox(height: 20),
          if (allowed) ...[
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(context.tr('checkIn')),
              subtitle: Text('$time · $zone'),
              value: checkIn,
              onChanged: busy || unknown
                  ? null
                  : (value) => setState(() => checkIn = value),
            ),
            if (checkIn)
              TextButton(
                onPressed: busy || unknown
                    ? null
                    : () async {
                        final parts = time.split(':');
                        final value = await showTimePicker(
                          context: context,
                          initialTime: TimeOfDay(
                            hour: int.parse(parts[0]),
                            minute: int.parse(parts[1]),
                          ),
                        );
                        if (value != null && mounted) {
                          setState(
                            () => time =
                                '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}',
                          );
                        }
                      },
                child: Text(context.tr('checkInTime')),
              ),
            FilledButton(
              onPressed: busy || unknown || selected == null
                  ? null
                  : () => _save(false),
              child: Text(context.tr('save')),
            ),
            if (saved?['agentId'] != null)
              TextButton(
                onPressed: busy || unknown ? null : () => _save(true),
                child: Text(context.tr('clearPrimary')),
              ),
          ],
        ],
      ),
    );
  }
}

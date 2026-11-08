import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

class TimeZoneSettings extends StatefulWidget {
  const TimeZoneSettings({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<TimeZoneSettings> createState() => _TimeZoneSettingsState();
}

class _TimeZoneSettingsState extends State<TimeZoneSettings> {
  final input = TextEditingController();
  Json? saved;
  bool busy = false;
  bool unknown = false;
  String? error;
  @override
  void initState() {
    super.initState();
    unawaited(_read());
  }

  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  Future<void> _read() async {
    try {
      final value = await widget.scope.request('GET', '/workspace-time-zone');
      if (mounted) {
        setState(() {
          saved = value;
          input.text = value['timeZone'] as String? ?? '';
          unknown = false;
          error = null;
        });
      }
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    }
  }

  Future<void> _save() async {
    if (busy || saved == null || unknown || input.text.trim().isEmpty) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.scope.request(
        'PUT',
        '/workspace-time-zone',
        body: {
          'expectedRevision': saved!['revision'],
          'timeZone': input.text.trim(),
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

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(context.tr('timeZone'))),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(context.tr('timeZoneHelp')),
        const SizedBox(height: 20),
        if (error != null)
          Notice(
            error!,
            action: 'refresh',
            onAction: busy
                ? null
                : () async {
                    if (await confirm(context, 'loadCurrent')) await _read();
                  },
          ),
        if (unknown) const Notice('requestUnknown'),
        TextField(
          controller: input,
          enabled: widget.scope.owner && saved != null && !busy && !unknown,
          autocorrect: false,
          decoration: InputDecoration(
            labelText: context.tr('timeZone'),
            hintText: 'Asia/Shanghai',
          ),
        ),
        const SizedBox(height: 20),
        if (widget.scope.owner)
          FilledButton(
            onPressed: busy || saved == null || unknown ? null : _save,
            child: Text(context.tr('save')),
          )
        else
          const Notice('readOnly'),
      ],
    ),
  );
}

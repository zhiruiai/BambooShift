import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import 'shell_action_data.dart';

class ShellActionDetails extends StatelessWidget {
  const ShellActionDetails({
    super.key,
    required this.payload,
    required this.local,
    this.result,
  });
  final Json payload;
  final bool local;
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final value = result is Json ? result as Json : <String, dynamic>{};
    final path = payload['path'];
    Widget output(String label, Object? data) {
      final text = data is String ? data : '';
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            context.tr(label),
            style: Theme.of(context).textTheme.labelLarge,
          ),
          SelectableText(
            text.isEmpty
                ? context.tr('shellNoOutput')
                : text.substring(0, text.length.clamp(0, 256 * 1024)),
          ),
          const SizedBox(height: 12),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 12),
        Text(
          context.tr('shellCommand'),
          style: Theme.of(context).textTheme.labelLarge,
        ),
        SelectableText(
          payload['command'] is String
              ? (payload['command'] as String).substring(
                  0,
                  (payload['command'] as String).length.clamp(0, 16000),
                )
              : '',
        ),
        if (!shellRequestReadable(payload))
          Text(context.tr('shellRequestIncomplete')),
        const SizedBox(height: 12),
        Text(
          '${context.tr('shellDirectory')}: ${!payload.containsKey('path') || path == '.'
              ? context.tr('shellRoot')
              : path is String
              ? path
              : context.tr('shellRequestIncomplete')}',
        ),
        Text(context.tr('shellTimeout')),
        Text(context.tr(local ? 'localShellScope' : 'shellIsolatedScope')),
        if (result != null)
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text(context.tr(shellResultLabel(value) ?? 'shellResult')),
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${context.tr('shellExitCode')}: ${value['exitCode'] is int ? value['exitCode'] : context.tr('shellNoExitCode')}',
                    ),
                    if (value['signal'] is String)
                      Text('${context.tr('shellSignal')}: ${value['signal']}'),
                    if (value['durationMs'] is num &&
                        (value['durationMs'] as num).isFinite &&
                        value['durationMs'] >= 0)
                      Text(
                        '${context.tr('shellDuration')}: ${((value['durationMs'] as num) / 1000).toStringAsFixed(1)} s',
                      ),
                    if (value['truncated'] == true)
                      Text(context.tr('shellTruncated')),
                    if (value['timedOut'] == true)
                      Text(context.tr('shellTimedOut')),
                    if (value['cancelled'] == true)
                      Text(context.tr('shellCancelled')),
                    output('shellStdout', value['stdout']),
                    output('shellStderr', value['stderr']),
                  ],
                ),
              ),
            ],
          ),
      ],
    );
  }
}

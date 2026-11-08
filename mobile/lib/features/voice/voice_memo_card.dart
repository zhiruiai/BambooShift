import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import 'voice_memo_controller.dart';
import 'voice_memo_data.dart';

class VoiceMemoCard extends StatelessWidget {
  const VoiceMemoCard(this.memo, {super.key, this.controller});

  final VoiceMemo memo;
  final VoiceMemoController? controller;

  String _time(int milliseconds) {
    final seconds = milliseconds ~/ 1000;
    return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final controller = this.controller;
    if (controller == null) return _card(context, null);
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) => _card(context, controller),
    );
  }

  Widget _card(BuildContext context, VoiceMemoController? control) {
    final selected = control?.selectedId == memo.messageId;
    final busy = selected && control?.busy == true;
    final playing = selected && control?.playing == true;
    final position = selected
        ? control!.positionMs.clamp(0, memo.durationMs)
        : 0;
    final failed = control?.failedId == memo.messageId;
    final canPlay = memo.available && control?.supported == true;
    final label = context.tr(playing ? 'voiceMemoPause' : 'voiceMemoPlay');
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 14, 6),
            child: Row(
              children: [
                if (canPlay)
                  IconButton.filledTonal(
                    tooltip: label,
                    onPressed: busy ? null : () => control!.toggle(memo),
                    icon: busy
                        ? const SizedBox.square(
                            dimension: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Icon(playing ? Icons.pause : Icons.play_arrow),
                  )
                else
                  const Padding(
                    padding: EdgeInsets.all(10),
                    child: Icon(Icons.graphic_eq),
                  ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.tr('voiceMemoTitle'),
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      Text(
                        selected
                            ? '${_time(position)} / ${_time(memo.durationMs)}'
                            : _time(memo.durationMs),
                        style: const TextStyle(fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (selected && !busy)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: LinearProgressIndicator(
                value: position / memo.durationMs,
                semanticsLabel: context.tr('voiceMemoProgress'),
              ),
            ),
          if (!memo.available || failed)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
              child: Text(
                context.tr(
                  failed ? 'voiceMemoPlaybackFailed' : 'voiceMemoUnavailable',
                ),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          ExpansionTile(
            tilePadding: const EdgeInsets.symmetric(horizontal: 16),
            title: Text(context.tr('voiceMemoTranscript')),
            expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
            childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            children: [SelectableText(memo.transcript)],
          ),
        ],
      ),
    );
  }
}

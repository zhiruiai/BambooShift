import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import 'voice_controller.dart';

class VoiceControls extends StatelessWidget {
  const VoiceControls(this.voice, {super.key});

  final VoiceController voice;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final status = switch (voice.phase) {
      VoicePhase.idle => '',
      VoicePhase.connecting => 'voiceConnecting',
      VoicePhase.listening => 'voiceListening',
      VoicePhase.dictating => 'voiceDictating',
      VoicePhase.transcribing => 'voiceTranscribing',
      VoicePhase.waiting => 'voiceWaiting',
      VoicePhase.speaking => 'voiceSpeaking',
      VoicePhase.muted => 'voiceMuted',
      VoicePhase.recovery => 'voiceUnknown',
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Material(
        color: scheme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: BorderSide(color: scheme.outlineVariant),
        ),
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: Row(
            children: [
              const SizedBox(width: 4),
              const Icon(Icons.graphic_eq, size: 20),
              const SizedBox(width: 10),
              Expanded(
                child: Semantics(
                  liveRegion: true,
                  child: Text(context.tr(status), softWrap: true),
                ),
              ),
              if (voice.calling && voice.call != null)
                IconButton(
                  tooltip: context.tr(
                    voice.muted ? 'voiceUnmute' : 'voiceMute',
                  ),
                  onPressed: voice.toggleMute,
                  icon: Icon(voice.muted ? Icons.mic_off : Icons.mic_none),
                ),
              if (voice.phase == VoicePhase.speaking)
                IconButton(
                  tooltip: context.tr('voiceInterrupt'),
                  onPressed: voice.interrupt,
                  icon: const Icon(Icons.volume_off_outlined),
                ),
              if (voice.phase == VoicePhase.dictating)
                IconButton(
                  tooltip: context.tr('voiceFinishDictation'),
                  onPressed: voice.finishDictation,
                  icon: const Icon(Icons.check),
                ),
              IconButton.filled(
                style: IconButton.styleFrom(
                  backgroundColor: voice.calling
                      ? scheme.errorContainer
                      : scheme.surfaceContainerHigh,
                  foregroundColor: voice.calling
                      ? scheme.onErrorContainer
                      : scheme.onSurface,
                ),
                tooltip: context.tr(voice.calling ? 'voiceHangUp' : 'cancel'),
                onPressed: voice.hangUp,
                icon: Icon(voice.calling ? Icons.call_end : Icons.close),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

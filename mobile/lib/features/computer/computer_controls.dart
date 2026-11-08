import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import 'computer_controller.dart';

class ComputerControls extends StatefulWidget {
  const ComputerControls({super.key, required this.controller});
  final ComputerController controller;
  @override
  State<ComputerControls> createState() => _ComputerControlsState();
}

class _ComputerControlsState extends State<ComputerControls> {
  final text = TextEditingController();
  String? leaseId;
  bool revealed = false;
  @override
  void initState() {
    super.initState();
    leaseId = widget.controller.lease?.id;
    widget.controller.addListener(changed);
  }

  void changed() {
    final c = widget.controller;
    final current = c.lease;
    if (!c.visible ||
        current == null ||
        current.id != leaseId ||
        current.expired ||
        c.uncertain ||
        c.releaseUnknown) {
      text.clear();
      if (revealed) setState(() => revealed = false);
    }
    leaseId = current?.id;
  }

  @override
  void dispose() {
    widget.controller.removeListener(changed);
    text.dispose();
    super.dispose();
  }

  Future<void> send() async {
    if (!widget.controller.canInput || text.text.isEmpty) return;
    final value = text.text;
    text.clear();
    if (revealed) setState(() => revealed = false);
    await widget.controller.input({'type': 'type', 'text': value});
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('mobileComputerClickHint')),
        const SizedBox(height: 12),
        TextField(
          key: const ValueKey('computer-text'),
          controller: text,
          enabled: c.canInput,
          maxLength: c.status?.virtualDesktop == true ? 300 : 20000,
          minLines: 1,
          maxLines: revealed ? 4 : 1,
          obscureText: !revealed,
          autocorrect: false,
          enableSuggestions: false,
          enableIMEPersonalizedLearning: false,
          keyboardType: revealed
              ? TextInputType.multiline
              : TextInputType.visiblePassword,
          smartDashesType: SmartDashesType.disabled,
          smartQuotesType: SmartQuotesType.disabled,
          decoration: InputDecoration(
            labelText: context.tr('mobileComputerText'),
            counterText: revealed ? null : '',
            suffixIcon: IconButton(
              tooltip: context.tr(
                revealed ? 'mobileComputerHideText' : 'mobileComputerShowText',
              ),
              onPressed: c.canInput
                  ? () => setState(() => revealed = !revealed)
                  : null,
              icon: Icon(revealed ? Icons.visibility_off : Icons.visibility),
            ),
          ),
        ),
        FilledButton.tonal(
          key: const ValueKey('computer-send-text'),
          onPressed: c.canInput ? send : null,
          child: Text(context.tr('mobileComputerSendText')),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final key in ['Enter', 'Tab', 'Backspace', 'Escape'])
              OutlinedButton(
                onPressed: c.canInput
                    ? () => c.input({'type': 'key', 'key': key})
                    : null,
                child: Text(context.tr('mobileComputerKey$key')),
              ),
            for (final direction in [-1, 1])
              OutlinedButton.icon(
                onPressed: c.canInput
                    ? () =>
                          c.input({'type': 'scroll', 'deltaY': direction * 400})
                    : null,
                icon: Icon(
                  direction < 0 ? Icons.arrow_upward : Icons.arrow_downward,
                ),
                label: Text(
                  context.tr(
                    direction < 0
                        ? 'mobileComputerScrollUp'
                        : 'mobileComputerScrollDown',
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

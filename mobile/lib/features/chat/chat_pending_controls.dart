import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';

class ChatPendingControls extends StatelessWidget {
  const ChatPendingControls({
    super.key,
    required this.onCheck,
    required this.onRetry,
  });
  final VoidCallback? onCheck, onRetry;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16),
    child: Column(
      children: [
        Notice('pendingMessage', action: 'checkResult', onAction: onCheck),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: TextButton(
            onPressed: onRetry,
            child: Text(context.tr('retry')),
          ),
        ),
      ],
    ),
  );
}

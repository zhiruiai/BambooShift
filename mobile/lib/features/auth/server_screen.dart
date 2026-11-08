import 'package:flutter/material.dart';

import '../../core/app_session.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

class ServerScreen extends StatefulWidget {
  const ServerScreen({super.key, required this.session, this.canClose = false});
  final AppSession session;
  final bool canClose;
  @override
  State<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends State<ServerScreen> {
  late final TextEditingController _address = TextEditingController(
    text: widget.session.api.server?.origin ?? '',
  );
  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    await widget.session.connect(_address.text);
    if (mounted && widget.canClose && widget.session.error == null) {
      Navigator.of(context).maybePop();
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.session,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        title: Text(context.tr('appName')),
        automaticallyImplyLeading: widget.canClose,
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(
                    Icons.forum_outlined,
                    size: 52,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                  const SizedBox(height: 24),
                  Text(
                    context.tr('serverTitle'),
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 12),
                  Text(context.tr('serverHelp')),
                  const SizedBox(height: 24),
                  TextField(
                    controller: _address,
                    enabled: !widget.session.busy,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: InputDecoration(
                      labelText: context.tr('server'),
                      hintText: context.tr('serverHint'),
                    ),
                    onSubmitted: (_) => _connect(),
                  ),
                  if (widget.session.error != null)
                    Notice(widget.session.error!),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: widget.session.busy ? null : _connect,
                    child: widget.session.busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(context.tr('connect')),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

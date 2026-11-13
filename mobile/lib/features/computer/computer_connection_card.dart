import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'computer_connection_controller.dart';

class ComputerConnectionCard extends StatefulWidget {
  const ComputerConnectionCard({super.key, required this.controller});
  final ComputerConnectionController controller;
  @override
  State<ComputerConnectionCard> createState() => _ComputerConnectionCardState();
}

class _ComputerConnectionCardState extends State<ComputerConnectionCard>
    with WidgetsBindingObserver {
  final address = TextEditingController(), token = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    address.addListener(_formChanged);
    token.addListener(_formChanged);
    widget.controller.addListener(_credentialsChanged);
  }

  void _formChanged() {
    if (mounted) setState(() {});
  }

  void _credentialsChanged() {
    final c = widget.controller;
    if (!c.active || !c.computer.visible || !c.computer.scope.owner) {
      token.clear();
    }
    if (!c.active) address.clear();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) token.clear();
  }

  @override
  void didUpdateWidget(ComputerConnectionCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_credentialsChanged);
      widget.controller.addListener(_credentialsChanged);
      token.clear();
      address.clear();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_credentialsChanged);
    address.removeListener(_formChanged);
    token.removeListener(_formChanged);
    token.dispose();
    address.dispose();
    super.dispose();
  }

  Future<void> act(String message, Future<void> Function() action) async {
    final c = widget.controller;
    if (await confirm(context, message) &&
        mounted &&
        identical(c, widget.controller) &&
        c.canChange) {
      await action();
    }
  }

  Future<void> pair() async {
    await act('mobileConnectionRemoteConfirm', () async {
      final secret = token.text;
      token.clear();
      await widget.controller.connectRemote(address.text, secret);
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final computer = c.computer;
      if (!c.active) return const SizedBox.shrink();
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                context.tr('mobileComputerLocalTitle'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(context.tr('mobileComputerLocalHelp')),
              if (c.loading || c.changing) const LinearProgressIndicator(),
              if (c.machine != null)
                Text(context.tr('mobileComputerLocation${c.location}')),
              if (c.error != null) Notice(c.error!),
              if (c.unknown) const Notice('mobileConnectionUnknown'),
              if (!computer.scope.owner) const Notice('mobileConnectionOwner'),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (computer.scope.owner &&
                      (!c.connected || c.location != 'server'))
                    FilledButton.tonal(
                      onPressed: c.canConnectLocal
                          ? () => act(
                              'mobileConnectionLocalConfirm',
                              c.connectLocal,
                            )
                          : null,
                      child: Text(context.tr('mobileConnectionLocal')),
                    ),
                  if (computer.scope.owner && c.connected)
                    TextButton(
                      onPressed: c.canChange
                          ? () => act(
                              'mobileConnectionDisconnectConfirm',
                              c.disconnect,
                            )
                          : null,
                      child: Text(context.tr('mobileConnectionDisconnect')),
                    ),
                  TextButton.icon(
                    onPressed: c.loading || c.changing || computer.busy
                        ? null
                        : () => c.refresh(),
                    icon: const Icon(Icons.refresh),
                    label: Text(context.tr('mobileConnectionRefresh')),
                  ),
                ],
              ),
              if (computer.scope.owner) ...[
                ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  title: Text(context.tr('mobileConnectionPair')),
                  children: [
                    Text(context.tr('mobileConnectionPairHelp')),
                    const SizedBox(height: 12),
                    TextField(
                      key: const ValueKey('worker-address'),
                      controller: address,
                      enabled: c.canChange,
                      autocorrect: false,
                      enableSuggestions: false,
                      keyboardType: TextInputType.url,
                      maxLength: 2048,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileConnectionAddress'),
                        hintText: 'https://',
                        counterText: '',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const ValueKey('worker-token'),
                      controller: token,
                      enabled: c.canChange,
                      obscureText: true,
                      autocorrect: false,
                      enableSuggestions: false,
                      enableIMEPersonalizedLearning: false,
                      keyboardType: TextInputType.visiblePassword,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileConnectionToken'),
                      ),
                    ),
                    const SizedBox(height: 12),
                    FilledButton(
                      onPressed:
                          c.canChange &&
                              computerWorkerAddress(address.text) != null &&
                              token.text.trim().isNotEmpty
                          ? pair
                          : null,
                      child: Text(context.tr('mobileConnectionConnect')),
                    ),
                    if (c.machine?['savedRemote'] is Map)
                      TextButton(
                        onPressed: c.canReconnect
                            ? () => act(
                                'mobileConnectionRemoteConfirm',
                                c.reconnect,
                              )
                            : null,
                        child: Text(context.tr('mobileConnectionReconnect')),
                      ),
                  ],
                ),
                if (computer.status?.ready == true &&
                    computer.status?.value['desktop'] is Map) ...[
                  const SizedBox(height: 8),
                  Text(context.tr('mobileConnectionSurface')),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final surface in ['browser', 'desktop'])
                        ChoiceChip(
                          label: Text(
                            context.tr('mobileConnectionSurface$surface'),
                          ),
                          selected: computer.status?.surface == surface,
                          onSelected:
                              c.canChange &&
                                  (surface == 'browser' || c.canSelectDesktop)
                              ? (_) => act(
                                  'mobileConnectionSurfaceConfirm',
                                  () => c.selectSurface(surface),
                                )
                              : null,
                        ),
                    ],
                  ),
                  if (!c.canSelectDesktop)
                    Text(context.tr('mobileConnectionDesktopHelp')),
                ],
              ],
            ],
          ),
        ),
      );
    },
  );
}

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../teaching/teaching_controller.dart';
import '../teaching/teaching_panel.dart';
import 'computer_controller.dart';
import 'computer_connection_controller.dart';
import 'computer_connection_card.dart';
import 'computer_data.dart';
import 'computer_controls.dart';
import 'cloud_computer_controller.dart';
import 'cloud_computer_card.dart';
import 'computer_picture.dart';
import 'screen_preparation_controller.dart';
import 'screen_preparation_card.dart';

class ComputerScreen extends StatefulWidget {
  const ComputerScreen({super.key, required this.scope, required this.agentId});
  final WorkspaceController scope;
  final String agentId;
  @override
  State<ComputerScreen> createState() => _ComputerScreenState();
}

class _ComputerScreenState extends State<ComputerScreen>
    with WidgetsBindingObserver {
  late ComputerController controller;
  late ComputerConnectionController connection;
  late TeachingController teaching;
  late CloudComputerController cloud;
  late ScreenPreparationController preparation;
  bool leaving = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    openComputer(widget.agentId);
  }

  void openComputer(String id) {
    controller = ComputerController(widget.scope, id);
    connection = ComputerConnectionController(controller);
    teaching = TeachingController(controller);
    cloud = CloudComputerController(controller);
    preparation = ScreenPreparationController(controller);
    unawaited(cloud.refresh());
    unawaited(connection.refresh(acknowledge: false));
    unawaited(teaching.initialize());
    unawaited(controller.refresh());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      controller.resume();
      unawaited(connection.refresh(acknowledge: false));
      unawaited(cloud.refresh());
      if (!teaching.ready) {
        unawaited(teaching.initialize());
      }
    } else {
      controller.suspend();
    }
  }

  void closeComputer() {
    preparation.dispose();
    connection.dispose();
    cloud.dispose();
    teaching.dispose();
    controller.dispose();
  }

  @override
  void didUpdateWidget(ComputerScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scope != widget.scope ||
        oldWidget.agentId != widget.agentId) {
      closeComputer();
      openComputer(widget.agentId);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    closeComputer();
    super.dispose();
  }

  Future<bool> releaseBeforeLeaving() async {
    if (controller.busy) return false;
    if (controller.lease != null && !await controller.end()) {
      if (!mounted) return false;
      return confirm(context, 'mobileComputerLeaveUnknown');
    }
    if (controller.unknownStart && mounted) {
      return confirm(context, 'mobileComputerLeaveUnknown');
    }
    return true;
  }

  Future<void> leave() async {
    if (leaving || !await releaseBeforeLeaving() || !mounted) return;
    setState(() => leaving = true);
    Navigator.pop(context);
  }

  Future<void> select(String id) async {
    if (id == controller.agentId ||
        !await releaseBeforeLeaving() ||
        !mounted ||
        !widget.scope.active) {
      return;
    }
    setState(() {
      closeComputer();
      openComputer(id);
    });
  }

  Future<void> start() async {
    if (!controller.canStart ||
        !await confirm(context, 'mobileComputerStartConfirm')) {
      return;
    }
    if (mounted) await controller.start();
  }

  Future<void> releaseControl() async {
    final current = controller;
    if (!await current.end() ||
        !mounted ||
        controller != current ||
        !current.active) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(context.tr('mobileComputerControlReturned'))),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      controller,
      widget.scope,
      widget.scope.session,
    ]),
    builder: (context, _) {
      final c = controller;
      if (!c.active) {
        return Scaffold(appBar: AppBar(), body: const Notice('scopeChanged'));
      }
      final name =
          widget.scope.find('agents', c.agentId)?['name'] as String? ?? '';
      return PopScope(
        canPop: leaving,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) unawaited(leave());
        },
        child: Scaffold(
          appBar: AppBar(
            title: Text(context.tr('mobileComputerTitle')),
            leading: IconButton(
              onPressed: c.busy ? null : leave,
              icon: const Icon(Icons.arrow_back),
            ),
          ),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(name, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              Text(
                context.tr('mobileComputerExecutionTitle'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              Notice(
                'mobileComputerLocation${c.status?.executionLocation ?? computerExecutionLocation(widget.scope.data?['computer'])}',
              ),
              ComputerConnectionCard(
                key: ObjectKey(connection),
                controller: connection,
              ),
              CloudComputerCard(controller: cloud),
              const Notice('mobileComputerPassive'),
              if (c.screens.isNotEmpty)
                ExpansionTile(
                  title: Text(context.tr('mobileComputerScreens')),
                  children: [
                    for (final b in c.screens)
                      ListTile(
                        title: Text(
                          widget.scope.find('agents', b['agentId'])?['name']
                                  as String? ??
                              '',
                        ),
                        subtitle: Text(
                          context.tr('mobileComputerStatus${b['status']}'),
                        ),
                        selected: b['agentId'] == c.agentId,
                        onTap: c.busy
                            ? null
                            : () => select(b['agentId'] as String),
                      ),
                  ],
                ),
              if (c.busy) const LinearProgressIndicator(),
              if (c.error != null) Notice(c.error!),
              if (c.status != null)
                Notice('mobileComputerStatus${c.status!.status}'),
              ScreenPreparationCard(controller: preparation),
              if (c.status?.status == 'unavailable' && !c.busy)
                const Notice('mobileComputerUnavailable'),
              if (c.status?.ready == true && c.status?.privateTakeover != true)
                const Notice('mobileComputerPrivateUnsupported'),
              if (c.unknownStart)
                const Notice('mobileComputerStartUnknown')
              else if (c.occupied && c.lease == null)
                const Notice('mobileComputerOccupied'),
              if (c.releaseUnknown)
                const Notice('mobileComputerEndUnknown')
              else if (c.uncertain)
                const Notice('mobileComputerInputUnknown'),
              if (c.lease != null) ...[
                Text(
                  '${context.tr('mobileComputerExpires')} ${c.lease!.expiresAt.toLocal()}',
                ),
                const SizedBox(height: 8),
              ],
              if (!c.releaseUnknown && (c.frame != null || c.lease != null))
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    context.tr(
                      c.lease == null
                          ? 'mobileComputerWatching'
                          : 'mobileComputerControlling',
                    ),
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                ),
              ComputerPicture(key: ObjectKey(c), controller: c),
              const SizedBox(height: 8),
              Text(
                context.tr(
                  c.frame?.isPrivate == true || c.lease != null
                      ? 'mobileComputerPrivateSnapshot'
                      : 'mobileComputerSnapshot',
                ),
              ),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton.icon(
                    onPressed: c.busy ? null : c.refresh,
                    icon: const Icon(Icons.refresh),
                    label: Text(context.tr('mobileComputerRefresh')),
                  ),
                  if (c.lease == null)
                    FilledButton(
                      onPressed: c.canStart ? start : null,
                      child: Text(context.tr('mobileComputerStart')),
                    )
                  else
                    OutlinedButton(
                      onPressed: c.busy || c.releaseUnknown
                          ? null
                          : releaseControl,
                      child: Text(context.tr('mobileComputerEnd')),
                    ),
                ],
              ),
              if (c.canAcknowledge)
                TextButton(
                  onPressed: c.acknowledge,
                  child: Text(context.tr('mobileComputerReviewed')),
                ),
              if (c.lease != null)
                ComputerControls(key: ValueKey(c), controller: c),
              TeachingPanel(
                key: ValueKey('teaching-${c.agentId}'),
                controller: teaching,
              ),
            ],
          ),
        ),
      );
    },
  );
}

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import 'chat_reads.dart';

class ChatReadObserver extends StatefulWidget {
  const ChatReadObserver({
    super.key,
    required this.scope,
    required this.conversationId,
    required this.rendered,
    required this.scroll,
    this.refreshToken = 0,
  });
  final WorkspaceController scope;
  final String conversationId;
  final Json? rendered;
  final ScrollController scroll;
  final int refreshToken;
  @override
  State<ChatReadObserver> createState() => _ChatReadObserverState();
}

class _ChatReadObserverState extends State<ChatReadObserver>
    with WidgetsBindingObserver {
  late ChatReads model;
  bool queued = false;
  @override
  void initState() {
    super.initState();
    model = ChatReads(widget.scope, widget.conversationId);
    WidgetsBinding.instance.addObserver(this);
    widget.scroll.addListener(schedule);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    schedule();
  }

  @override
  void didUpdateWidget(ChatReadObserver old) {
    super.didUpdateWidget(old);
    if (!identical(old.scope, widget.scope) ||
        old.conversationId != widget.conversationId) {
      model.dispose();
      model = ChatReads(widget.scope, widget.conversationId);
    }
    if (!identical(old.scroll, widget.scroll)) {
      old.scroll.removeListener(schedule);
      widget.scroll.addListener(schedule);
    }
    if (old.refreshToken != widget.refreshToken) model.retry();
    schedule();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) schedule();
  }

  bool visible() {
    if (!mounted ||
        !widget.scope.active ||
        ModalRoute.of(context)?.isCurrent != true) {
      return false;
    }
    final state = WidgetsBinding.instance.lifecycleState;
    if (state != null && state != AppLifecycleState.resumed) return false;
    return widget.scroll.hasClients
        ? widget.scroll.position.hasContentDimensions &&
              widget.scroll.position.viewportDimension > 0 &&
              widget.scroll.offset <=
                  widget.scroll.position.minScrollExtent + 24
        : !widget.scope
              .items('messages')
              .any((m) => m['conversationId'] == widget.conversationId);
  }

  void schedule() {
    if (!mounted || queued) return;
    queued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      queued = false;
      if (!mounted) return;
      final current = model;
      unawaited(
        current.viewed(widget.rendered, visible).then((attempted) {
          if (attempted && mounted && identical(current, model)) schedule();
        }),
      );
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.scroll.removeListener(schedule);
    model.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

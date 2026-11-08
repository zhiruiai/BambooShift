import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_session.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import '../../widgets/common.dart';
import '../bots/bot_settings.dart';
import '../bots/create_screen.dart';
import '../chat/chat_screen.dart';
import '../inbound_share/inbound_share_data.dart';
import '../inbound_share/inbound_share_inbox.dart';
import '../inbound_share/inbound_share_screen.dart';
import '../settings/workspace_settings.dart';
import '../roster/roster_list.dart';
import '../bot_library/library_screen.dart';
import '../bot_library/library_navigation.dart';
import 'workspace_search_screen.dart';

class WorkspaceScreen extends StatefulWidget {
  const WorkspaceScreen({super.key, required this.session, this.inboundShare});
  final AppSession session;
  final InboundShareInbox? inboundShare;
  @override
  State<WorkspaceScreen> createState() => _WorkspaceScreenState();
}

class _WorkspaceScreenState extends State<WorkspaceScreen>
    with WidgetsBindingObserver {
  late final WorkspaceController scope;
  int tab = 0;
  String? offeredShare;
  bool reviewingShare = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    scope = WorkspaceController(widget.session);
    scope.addListener(_offerShare);
    widget.inboundShare?.addListener(_offerShare);
    unawaited(_start());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && scope.active) {
        unawaited(widget.session.avatarSync.reload());
      }
    });
  }

  void _offerShare() {
    final packet = widget.inboundShare?.packet;
    if (!mounted ||
        !scope.active ||
        scope.data == null ||
        reviewingShare ||
        packet == null ||
        offeredShare == packet.id) {
      return;
    }
    offeredShare = packet.id;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_reviewShare(packet));
    });
  }

  Future<void> _reviewShare(InboundSharePacket packet) async {
    final inbox = widget.inboundShare;
    if (!scope.active ||
        reviewingShare ||
        inbox == null ||
        !inbox.contains(packet)) {
      return;
    }
    reviewingShare = true;
    try {
      final id = await Navigator.of(context).push<String>(
        MaterialPageRoute(
          builder: (_) =>
              InboundShareScreen(scope: scope, inbox: inbox, packet: packet),
        ),
      );
      if (mounted &&
          scope.active &&
          id != null &&
          scope.find('conversations', id) != null) {
        _chat(id);
      }
    } finally {
      reviewingShare = false;
    }
  }

  Future<void> _start() async {
    await scope.start();
    if (!mounted || !scope.active) return;
    final requested = takeLibraryOpen(scope);
    if (requested == null) return;
    if (scope.data != null && requested.matches(scope.data!)) {
      _chat(requested.conversationId);
    } else {
      setState(() => scope.error = 'mobileLibraryCreatedUnavailable');
    }
  }

  Future<void> _library() async {
    final destination = await Navigator.push<LibraryOpen>(
      context,
      MaterialPageRoute(builder: (_) => BotLibraryScreen(scope: scope)),
    );
    if (!mounted || !scope.active || destination == null) return;
    if (destination.workspace['id'] == scope.workspaceId) {
      await scope.refresh();
      if (mounted &&
          scope.active &&
          scope.data != null &&
          destination.matches(scope.data!)) {
        _chat(destination.conversationId);
      } else if (mounted && scope.active) {
        setState(() => scope.error = 'mobileLibraryCreatedUnavailable');
      }
      return;
    }
    queueLibraryOpen(scope, destination);
    widget.session.selectWorkspace(destination.workspace);
    if (widget.session.workspaceId != destination.workspace['id']) {
      clearLibraryOpen(widget.session);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    scope.removeListener(_offerShare);
    widget.inboundShare?.removeListener(_offerShare);
    scope.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      scope.resume();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      scope.pause();
    }
  }

  void _chat(String id) {
    Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => ChatScreen(scope: scope, conversationId: id),
      ),
    );
  }

  Future<void> _create(String kind) async {
    final id = await Navigator.push<String>(
      context,
      MaterialPageRoute(
        builder: (_) => CreateScreen(scope: scope, kind: kind),
      ),
    );
    if (id != null && mounted && scope.active) _chat(id);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([scope, widget.inboundShare]),
    builder: (context, _) {
      return Scaffold(
        appBar: AppBar(
          title: Text(
            widget.session.workspace?['name'] as String? ??
                context.tr('appName'),
            overflow: TextOverflow.ellipsis,
          ),
          leading: IconButton(
            tooltip: context.tr('chooseWorkspace'),
            onPressed: () => widget.session.selectWorkspace(null),
            icon: const Icon(Icons.space_dashboard_outlined),
          ),
          actions: [
            if (widget.inboundShare?.packet case final packet?)
              IconButton(
                tooltip: context.tr('mobileInboundTitle'),
                onPressed: scope.active && scope.data != null
                    ? () => _reviewShare(packet)
                    : null,
                icon: const Icon(Icons.move_to_inbox_outlined),
              ),
            IconButton(
              tooltip: context.tr('mobileSearchTitle'),
              onPressed: scope.active && scope.data != null
                  ? () => Navigator.push(
                      context,
                      MaterialPageRoute<void>(
                        builder: (_) => WorkspaceSearchScreen(scope: scope),
                      ),
                    )
                  : null,
              icon: const Icon(Icons.search),
            ),
            IconButton(
              tooltip: context.tr('mobileLibraryTitle'),
              onPressed: scope.active ? _library : null,
              icon: const Icon(Icons.library_books_outlined),
            ),
            if (tab < 2)
              PopupMenuButton<String>(
                tooltip: context.tr('create'),
                onSelected: _create,
                itemBuilder: (_) => [
                  if (scope.owner)
                    PopupMenuItem(
                      value: 'bot',
                      child: Text(context.tr('newBot')),
                    ),
                  PopupMenuItem(
                    value: 'group',
                    child: Text(context.tr('newGroup')),
                  ),
                ],
              ),
          ],
        ),
        body: scope.data == null
            ? Center(
                child: scope.error == null
                    ? const CircularProgressIndicator()
                    : Notice(
                        scope.error!,
                        action: 'retry',
                        onAction: () => scope.refresh(),
                      ),
              )
            : tab == 2
            ? WorkspaceSettings(scope: scope)
            : RefreshIndicator(
                onRefresh: scope.refresh,
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (scope.error != null) Notice(scope.error!),
                    if (scope.disconnected) const Notice('progressNotice'),
                    if (tab == 0) ...[
                      RosterList(scope: scope, onOpen: _chat),
                    ] else ...[
                      for (final bot in scope.items('agents'))
                        Card(
                          child: ListTile(
                            contentPadding: const EdgeInsets.all(16),
                            leading: BotAvatar(
                              bot: bot,
                              family: widget.session.avatarTheme,
                              scope: scope,
                            ),
                            title: Text(bot['name'] as String? ?? ''),
                            subtitle: Text(bot['role'] as String? ?? ''),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => Navigator.push(
                              context,
                              MaterialPageRoute<void>(
                                builder: (_) =>
                                    BotSettings(scope: scope, bot: bot),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ],
                ),
              ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: tab,
          onDestinationSelected: (value) => setState(() => tab = value),
          destinations: [
            NavigationDestination(
              icon: const Icon(Icons.chat_bubble_outline),
              label: context.tr('chats'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.smart_toy_outlined),
              label: context.tr('bots'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.tune),
              label: context.tr('settings'),
            ),
          ],
        ),
      );
    },
  );
}

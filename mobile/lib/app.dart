import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/app_session.dart';
import 'features/auth/auth_screen.dart';
import 'features/auth/server_screen.dart';
import 'features/files/file_export_housekeeping.dart';
import 'features/inbound_share/inbound_share_bridge.dart';
import 'features/inbound_share/inbound_share_inbox.dart';
import 'features/workspaces/workspace_picker.dart';
import 'features/workspaces/workspace_screen.dart';
import 'l10n/strings.dart';
import 'theme.dart';
import 'widgets/avatar_appearance.dart';

class OpenBotApp extends StatefulWidget {
  const OpenBotApp({super.key, required this.session, this.shareBridge});
  final AppSession session;
  final InboundShareBridge? shareBridge;
  @override
  State<OpenBotApp> createState() => _OpenBotAppState();
}

class _OpenBotAppState extends State<OpenBotApp> {
  final fileExports = FileExportHousekeeping();
  InboundShareInbox? inboundShare;

  @override
  void initState() {
    super.initState();
    fileExports.start();
    if ((widget.shareBridge ?? platformInboundShare()) case final bridge?) {
      inboundShare = InboundShareInbox(widget.session, bridge)..start();
    }
    unawaited(widget.session.initialize());
  }

  @override
  void dispose() {
    fileExports.dispose();
    inboundShare?.dispose();
    widget.session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.session,
    builder: (context, _) {
      final session = widget.session;
      return MaterialApp(
        key: ValueKey(session.identityKey),
        debugShowCheckedModeBanner: false,
        onGenerateTitle: (context) => context.tr('appName'),
        theme: openBotTheme(Brightness.light),
        darkTheme: openBotTheme(Brightness.dark),
        themeMode: session.theme,
        builder: (_, child) => AvatarAppearance(
          session: session,
          child: child ?? const SizedBox.shrink(),
        ),
        locale: session.locale,
        supportedLocales: const [Locale('zh'), Locale('en')],
        localizationsDelegates: const [
          Strings.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: !session.ready
            ? const Scaffold(body: Center(child: CircularProgressIndicator()))
            : session.api.server == null
            ? ServerScreen(session: session)
            : session.user == null
            ? AuthScreen(session: session)
            : session.workspace == null
            ? WorkspacePicker(session: session)
            : WorkspaceScreen(
                key: ValueKey(session.identityKey),
                session: session,
                inboundShare: inboundShare,
              ),
      );
    },
  );
}

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../files/website_project_card.dart';
import 'chat_library_data.dart';
import 'chat_library_links.dart';
import 'file_card.dart';

class ChatProjectLibrary extends StatelessWidget {
  const ChatProjectLibrary(this.scope, this.conversationId, {super.key});

  final WorkspaceController scope;
  final String conversationId;

  @override
  Widget build(BuildContext context) {
    final open = chatProjectLibraryAction(context, scope, conversationId);
    return open == null
        ? const SizedBox.shrink()
        : IconButton(
            tooltip: context.tr('mobileChatLibraryTitle'),
            icon: const Icon(Icons.folder_outlined),
            onPressed: open,
          );
  }
}

VoidCallback? chatProjectLibraryAction(
  BuildContext context,
  WorkspaceController scope,
  String conversationId,
) {
  bool available() =>
      scope.active && scope.find('conversations', conversationId) != null;
  if (!available() || conversationLibraryItems(scope, conversationId).isEmpty) {
    return null;
  }
  return () {
    if (!context.mounted || !available()) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            _ConversationLibrary(scope: scope, conversationId: conversationId),
      ),
    );
  };
}

enum _LibraryFilter {
  all('mobileChatLibraryAll'),
  pinned('mobileRosterPinned'),
  websites('mobileChatLibraryWebsites'),
  files('mobileSearchFiles'),
  media('mobileChatLibraryMedia'),
  links('mobileSearchLinks');

  const _LibraryFilter(this.label);
  final String label;
}

class _ConversationLibrary extends StatefulWidget {
  const _ConversationLibrary({
    required this.scope,
    required this.conversationId,
  });
  final WorkspaceController scope;
  final String conversationId;

  @override
  State<_ConversationLibrary> createState() => _ConversationLibraryState();
}

class _ConversationLibraryState extends State<_ConversationLibrary> {
  static const pageSize = 12;
  final _scroll = ScrollController();
  _LibraryFilter _filter = _LibraryFilter.all;
  int _visible = pageSize;
  int _read = 0;
  bool _pinsReady = false;
  bool _loadError = false;
  bool _saveError = false;
  bool _refreshAfterSave = false;
  LibraryItemKey? _saving;
  (Object?, Object?)? _revision;
  List<LibraryItemKey> _pins = const [];

  bool get _active =>
      mounted &&
      widget.scope.active &&
      widget.scope.find('conversations', widget.conversationId) != null;
  String get _pinPath =>
      '/conversations/${Uri.encodeComponent(widget.conversationId)}/library/pins';

  (Object?, Object?)? get _syncRevision {
    final sync = widget.scope.data?['sync'];
    return sync is Map ? (sync['epoch'], sync['revision']) : null;
  }

  @override
  void initState() {
    super.initState();
    _revision = _syncRevision;
    widget.scope.addListener(_observeScope);
    unawaited(_loadPins());
  }

  @override
  void dispose() {
    widget.scope.removeListener(_observeScope);
    _scroll.dispose();
    super.dispose();
  }

  void _observeScope() {
    final revision = _syncRevision;
    if (!_active || revision == _revision) return;
    _revision = revision;
    if (_saving != null) {
      _refreshAfterSave = true;
    } else {
      unawaited(_loadPins());
    }
  }

  Future<void> _loadPins() async {
    if (!_active) return;
    final read = ++_read;
    try {
      final pins = conversationLibraryPins(
        await widget.scope.request('GET', _pinPath),
      );
      if (_active && read == _read) {
        setState(() {
          _pins = pins;
          _pinsReady = true;
          _loadError = false;
        });
      }
    } catch (_) {
      if (_active && read == _read) setState(() => _loadError = true);
    }
  }

  Future<void> _setPinned(LibraryItem item, bool pinned) async {
    if (!_active || !_pinsReady || _loadError || _saving != null) return;
    _read++;
    setState(() {
      _saving = item.key;
      _saveError = false;
    });
    try {
      final pins = conversationLibraryPins(
        await widget.scope.request(
          'PUT',
          _pinPath,
          body: item.pinRequest(pinned),
        ),
      );
      if (pins.contains(item.key) != pinned) {
        throw const FormatException('Unexpected library pin response');
      }
      if (_active) setState(() => _pins = pins);
    } catch (_) {
      if (_active) setState(() => _saveError = true);
      _refreshAfterSave = true;
    } finally {
      if (_active) {
        setState(() => _saving = null);
        if (_refreshAfterSave) {
          _refreshAfterSave = false;
          unawaited(_loadPins());
        }
      }
    }
  }

  void _selectFilter(_LibraryFilter filter) {
    if (_filter == filter) return;
    if (_scroll.hasClients) _scroll.jumpTo(0);
    setState(() {
      _filter = filter;
      _visible = pageSize;
    });
  }

  bool _matches(LibraryItem item, Set<LibraryItemKey> pinned) =>
      switch (_filter) {
        _LibraryFilter.all => true,
        _LibraryFilter.pinned => pinned.contains(item.key),
        _LibraryFilter.websites => item.key.kind == LibraryItemKind.website,
        _LibraryFilter.files =>
          item.key.kind == LibraryItemKind.file && !item.media,
        _LibraryFilter.media => item.media,
        _LibraryFilter.links => item.key.kind == LibraryItemKind.link,
      };

  Widget _card(LibraryItem item) => switch (item.key.kind) {
    LibraryItemKind.website => WebsiteProjectCard(
      scope: widget.scope,
      message: item.message!,
    ),
    LibraryItemKind.file =>
      item.message == null
          ? ChatFileCard.registered(
              scope: widget.scope,
              fileId: item.key.target,
              conversationId: widget.conversationId,
            )
          : ChatFileCard(scope: widget.scope, message: item.message!),
    LibraryItemKind.link => ChatLibraryLinkTile(
      scope: widget.scope,
      conversationId: widget.conversationId,
      item: item.link!,
    ),
  };

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(context.tr('mobileChatLibraryTitle'))),
    body: ListenableBuilder(
      listenable: Listenable.merge([widget.scope, widget.scope.session]),
      builder: (context, _) {
        if (!_active) return Center(child: Text(context.tr('scopeChanged')));
        return _library(context);
      },
    ),
  );

  Widget _library(BuildContext context) {
    final pinned = _pins.toSet();
    final all = conversationLibraryItems(
      widget.scope,
      widget.conversationId,
    ).where((item) => _matches(item, pinned)).toList();
    final byKey = {for (final item in all) item.key: item};
    final ordered = [
      for (final key in _pins)
        if (byKey[key] case final LibraryItem item) item,
      ...all.where((item) => !pinned.contains(item.key)),
    ];
    final showPinnedTitle =
        _filter == _LibraryFilter.all &&
        ordered.isNotEmpty &&
        pinned.contains(ordered.first.key);
    final more = all.every((item) => item.key.kind == LibraryItemKind.file)
        ? 'mobileChatLibraryMoreFiles'
        : all.every((item) => item.key.kind == LibraryItemKind.link)
        ? 'mobileChatLibraryMoreLinks'
        : 'mobileChatLibraryMoreItems';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: Row(
            spacing: 8,
            children: [
              for (final filter in _LibraryFilter.values)
                ChoiceChip(
                  label: Text(context.tr(filter.label)),
                  selected: _filter == filter,
                  onSelected: (_) => _selectFilter(filter),
                ),
            ],
          ),
        ),
        if (_loadError)
          ListTile(
            title: Text(context.tr('mobileChatLibraryPinsLoadError')),
            trailing: TextButton(
              onPressed: _loadPins,
              child: Text(context.tr('retry')),
            ),
          ),
        if (_saveError)
          ListTile(title: Text(context.tr('mobileChatLibraryPinSaveError'))),
        if (!_pinsReady && !_loadError && _filter == _LibraryFilter.pinned)
          const LinearProgressIndicator()
        else if (ordered.isEmpty &&
            _loadError &&
            _filter == _LibraryFilter.pinned)
          const SizedBox.shrink()
        else if (ordered.isEmpty)
          Expanded(
            child: Center(
              child: Text(
                context.tr(
                  _filter == _LibraryFilter.pinned
                      ? 'mobileChatLibraryNoPins'
                      : 'mobileChatLibraryEmpty',
                ),
              ),
            ),
          )
        else
          Expanded(
            child: ListView(
              controller: _scroll,
              padding: const EdgeInsets.all(12),
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (showPinnedTitle)
                      Padding(
                        padding: const EdgeInsetsDirectional.only(
                          start: 12,
                          bottom: 6,
                        ),
                        child: Text(
                          context.tr('mobileChatLibraryPinnedItems'),
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                      ),
                    for (final item in ordered.take(_visible))
                      Row(
                        key: ValueKey(item.key),
                        children: [
                          Expanded(child: _card(item)),
                          IconButton(
                            icon: _saving == item.key
                                ? const SizedBox.square(
                                    dimension: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : Icon(
                                    pinned.contains(item.key)
                                        ? Icons.push_pin
                                        : Icons.push_pin_outlined,
                                  ),
                            tooltip: context.tr(
                              pinned.contains(item.key)
                                  ? 'mobileChatLibraryUnpin'
                                  : 'mobileChatLibraryPin',
                            ),
                            onPressed:
                                _pinsReady && !_loadError && _saving == null
                                ? () => _setPinned(
                                    item,
                                    !pinned.contains(item.key),
                                  )
                                : null,
                          ),
                        ],
                      ),
                    if (_visible < ordered.length)
                      Align(
                        alignment: AlignmentDirectional.centerStart,
                        child: TextButton(
                          onPressed: () => setState(() => _visible += pageSize),
                          child: Text(context.tr(more)),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }
}

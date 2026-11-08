import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'routine_webhook_data.dart';

class RoutineWebhookScreen extends StatefulWidget {
  const RoutineWebhookScreen({
    super.key,
    required this.scope,
    required this.routineId,
    required this.agentId,
    required this.conversationId,
  });

  final WorkspaceController scope;
  final String routineId, agentId, conversationId;

  @override
  State<RoutineWebhookScreen> createState() => _RoutineWebhookScreenState();
}

enum _CopyField { endpoint, key, authorization }

class _RoutineWebhookScreenState extends State<RoutineWebhookScreen>
    with WidgetsBindingObserver {
  WorkspaceController get _scope => widget.scope;
  String get _path => '/routines/${widget.routineId}/webhook';
  late bool _foreground, _scopeAllowed;
  int _visibility = 0;
  bool _busy = false, _closing = false;
  RoutineWebhookStatus? _status;
  String? _secret, _notice, _copyNotice;

  bool get _allowed {
    final routine = _scope.find('routines', widget.routineId);
    return mounted &&
        routine != null &&
        routine['agentId'] == widget.agentId &&
        routine['conversationId'] == widget.conversationId &&
        canManageRoutineWebhook(_scope, routine);
  }

  bool get _ready => !_closing && _foreground && _allowed;
  bool _visible(int generation) => _ready && generation == _visibility;

  @override
  void initState() {
    super.initState();
    final state = WidgetsBinding.instance.lifecycleState;
    _foreground = state == null || state == AppLifecycleState.resumed;
    _scopeAllowed = _allowed;
    WidgetsBinding.instance.addObserver(this);
    _scope.addListener(_scopeChanged);
    _scope.session.addListener(_scopeChanged);
    unawaited(_refresh());
  }

  @override
  void dispose() {
    _secret = null;
    _visibility++;
    WidgetsBinding.instance.removeObserver(this);
    _scope.removeListener(_scopeChanged);
    _scope.session.removeListener(_scopeChanged);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    if (foreground == _foreground) return;
    _foreground = foreground;
    _conceal();
  }

  void _scopeChanged() {
    final allowed = _allowed;
    if (allowed == _scopeAllowed) return;
    _scopeAllowed = allowed;
    _conceal();
  }

  void _conceal() {
    setState(() {
      _visibility++;
      _secret = null;
      _status = null;
      _notice = null;
      _copyNotice = null;
    });
    if (_ready && !_busy) unawaited(_refresh());
  }

  Future<RoutineWebhookStatus> _read() async {
    final value = await _scope.request('GET', _path);
    return parseRoutineWebhook(
      value,
      routineWebhookPath(_scope, widget.routineId)!,
    ).status;
  }

  Future<void> _refresh() => _work((generation) async {
    try {
      final current = await _read();
      if (_visible(generation)) _status = current;
    } catch (error) {
      if (_visible(generation)) {
        _status = null;
        _notice = switch (error) {
          ApiException(status: 404 || 405) => 'routineWebhookUnavailable',
          ApiException(status: 403) ||
          ApiException(
            code: 'ROUTINE_WEBHOOK_TARGET',
          ) => 'routineWebhookTarget',
          _ => 'requestFailed',
        };
      }
    }
  });

  Future<void> _work(Future<void> Function(int) action) async {
    if (!_ready || _busy) return;
    final generation = _visibility;
    setState(() {
      _busy = true;
      _secret = null;
      _notice = null;
      _copyNotice = null;
    });
    try {
      await action(generation);
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        // Read back after an in-flight write completes across a visibility change.
        if (_ready && generation != _visibility) unawaited(_refresh());
      }
    }
  }

  Future<void> _change(bool enabled) async {
    final reviewed = _status;
    final generation = _visibility;
    if (!_ready || _busy || reviewed == null) return;
    final confirmation = enabled
        ? reviewed.enabled
              ? 'routineWebhookRotateConfirm'
              : 'routineWebhookIssueConfirm'
        : 'routineWebhookRevokeConfirm';
    if (!await confirm(context, confirmation) ||
        !_visible(generation) ||
        reviewed != _status) {
      return;
    }
    await _work((generation) async {
      try {
        final value = await _scope.request(
          enabled ? 'PUT' : 'DELETE',
          _path,
          body: {'expectedRevision': reviewed.revision},
        );
        if (!_visible(generation)) return;
        final saved = parseRoutineWebhook(
          value,
          routineWebhookPath(_scope, widget.routineId)!,
          writtenEnabled: enabled,
        );
        if (saved.status.revision == reviewed.revision) {
          throw const ApiException('INVALID_RESPONSE', 'routineWebhookUnknown');
        }
        _status = saved.status;
        _secret = saved.secret;
        _notice = enabled ? 'routineWebhookIssued' : 'routineWebhookRevoked';
      } catch (error) {
        if (!_visible(generation)) return;
        _status = null;
        final stale =
            error is ApiException &&
            error.status == 409 &&
            error.code == 'ROUTINE_WEBHOOK_CHANGED';
        _notice = stale ? 'routineWebhookChanged' : 'routineWebhookUnknown';
        try {
          final readback = await _read();
          if (_visible(generation)) _status = readback;
        } catch (_) {
          // Keep actions disabled until an authoritative read succeeds.
        }
      }
    });
  }

  Uri? get _endpoint {
    final path = _status?.path;
    return path == null ? null : _scope.session.api.resolve(path);
  }

  Future<void> _copy(_CopyField field) async {
    final generation = _visibility;
    if (!_visible(generation) || _busy) return;
    final secret = _secret;
    final value = switch (field) {
      _CopyField.endpoint => _endpoint?.toString(),
      _CopyField.key => secret,
      _CopyField.authorization =>
        secret == null ? null : 'Authorization: Bearer $secret',
    };
    if (value == null) return;
    var message = 'copied';
    try {
      await Clipboard.setData(ClipboardData(text: value));
    } catch (_) {
      message = 'requestFailed';
    }
    if (_visible(generation)) setState(() => _copyNotice = message);
  }

  Widget _copyButton(String label, _CopyField field) => TextButton.icon(
    onPressed: _busy ? null : () => _copy(field),
    icon: const Icon(Icons.copy_outlined),
    label: Text(context.tr(label)),
  );

  @override
  Widget build(BuildContext context) => PopScope(
    onPopInvokedWithResult: (popped, _) {
      if (!popped) return;
      _closing = true;
      _conceal();
    },
    child: _page(context),
  );

  Widget _page(BuildContext context) {
    final status = _status;
    return Scaffold(
      appBar: AppBar(
        title: Text(context.tr('routineWebhookTitle')),
        actions: [
          IconButton(
            onPressed: _ready && !_busy ? _refresh : null,
            tooltip: context.tr('refresh'),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: !_allowed
          ? const Notice('routineWebhookTarget')
          : !_foreground || _closing
          ? const SizedBox.expand()
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(context.tr('routineWebhookHelp')),
                const SizedBox(height: 10),
                Text(context.tr('routineWebhookManual')),
                if (_busy) const LinearProgressIndicator(),
                if (_notice case final notice?) Notice(notice),
                if (status != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    context.tr(
                      status.enabled
                          ? 'routineWebhookActive'
                          : 'routineWebhookOff',
                    ),
                  ),
                  if (_endpoint case final endpoint?) ...[
                    if (_copyNotice case final notice?)
                      Semantics(
                        liveRegion: true,
                        child: Text(context.tr(notice)),
                      ),
                    const SizedBox(height: 8),
                    SelectableText(endpoint.toString()),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: _copyButton(
                        'routineWebhookCopyEndpoint',
                        _CopyField.endpoint,
                      ),
                    ),
                    Text(context.tr('routineWebhookRequest')),
                  ],
                  if (_secret case final key?) ...[
                    const Notice('routineWebhookOneTime'),
                    Text(key),
                    Wrap(
                      spacing: 8,
                      children: [
                        _copyButton('routineWebhookCopyKey', _CopyField.key),
                        _copyButton(
                          'routineWebhookCopyAuth',
                          _CopyField.authorization,
                        ),
                      ],
                    ),
                  ],
                ],
              ],
            ),
      bottomNavigationBar: !_ready || status == null
          ? null
          : SafeArea(
              top: false,
              minimum: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: Wrap(
                spacing: 8,
                children: [
                  FilledButton(
                    onPressed: _busy ? null : () => _change(true),
                    child: Text(
                      context.tr(
                        status.enabled
                            ? 'routineWebhookRotate'
                            : 'routineWebhookIssue',
                      ),
                    ),
                  ),
                  if (status.enabled)
                    OutlinedButton(
                      onPressed: _busy ? null : () => _change(false),
                      child: Text(context.tr('routineWebhookRevoke')),
                    ),
                ],
              ),
            ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'app_approval_data.dart';
import 'app_approval_review.dart';
import 'apps_transport.dart';

class AppApprovalRulesScreen extends StatefulWidget {
  const AppApprovalRulesScreen({super.key, required this.scope});
  final WorkspaceController scope;

  @override
  State<AppApprovalRulesScreen> createState() => _AppApprovalRulesScreenState();
}

class _AppApprovalRulesScreenState extends State<AppApprovalRulesScreen> {
  late final AppsTransport _transport = AppsTransport(widget.scope);
  List<AppApprovalRule> _rules = const [];
  String? _error;
  bool _busy = false, _invalidated = false;
  bool get _active => mounted && !_invalidated && widget.scope.personalOwner;

  @override
  void initState() {
    super.initState();
    widget.scope.session.addListener(_scopeChanged);
    unawaited(_refresh());
  }

  void _scopeChanged() {
    if (_active || _invalidated) return;
    _transport.close();
    setState(() {
      _invalidated = true;
      _rules = const [];
      _error = null;
    });
  }

  @override
  void dispose() {
    widget.scope.session.removeListener(_scopeChanged);
    _transport.close();
    super.dispose();
  }

  Future<List<AppApprovalRule>> _load() async => AppApprovalRule.list(
    await _transport.send('GET', '/apps/approval-rules'),
  );

  Future<void> _refresh() async {
    if (!_active || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final rules = await _load();
      if (_active) setState(() => _rules = rules);
    } catch (e) {
      if (_active) {
        setState(() {
          _rules = const [];
          _error = e is ApiException && e.status == 404
              ? 'mobileAppsRuleUnsupported'
              : 'requestFailed';
        });
      }
    } finally {
      if (_active) setState(() => _busy = false);
    }
  }

  Future<void> _revoke(AppApprovalRule rule) async {
    if (!await confirmAppApprovalRule(
          context,
          widget.scope,
          rule.read,
          revoke: true,
        ) ||
        !_active ||
        _busy ||
        !_rules.any((value) => value.id == rule.id)) {
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      final response = await _transport.send(
        'DELETE',
        '/apps/approval-rules/${rule.id}',
      );
      if (response is! Json || response['ok'] != true) {
        throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
      }
    } catch (_) {
      error = 'mobileAppsRuleRevokeUnknown';
    }
    if (!_active) return;
    try {
      final rules = await _load();
      if (_active) {
        setState(() {
          _rules = rules;
          _error = rules.any((value) => value.id == rule.id)
              ? 'mobileAppsRuleRevokeUnknown'
              : null;
        });
      }
    } catch (_) {
      if (_active) {
        setState(() {
          _rules = const [];
          _error = error ?? 'requestFailed';
        });
      }
    } finally {
      if (_active) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(context.tr('mobileAppsRulesTitle')),
      actions: [
        IconButton(
          onPressed: _active && !_busy ? _refresh : null,
          tooltip: context.tr('mobileAppsRefresh'),
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: !_active
        ? const Notice('scopeChanged')
        : ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(context.tr('mobileAppsRulesIntro')),
              if (_busy) const LinearProgressIndicator(),
              if (_error != null) Notice(_error!),
              if (!_busy && _rules.isEmpty && _error == null)
                const Notice('mobileAppsRulesEmpty'),
              for (final rule in _rules)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AppApprovalScopeDetails(read: rule.read),
                        OutlinedButton(
                          onPressed: _busy ? null : () => _revoke(rule),
                          child: Text(context.tr('mobileAppsRuleRevoke')),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
  );
}

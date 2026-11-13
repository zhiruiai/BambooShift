import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import 'remote_mcp_import.dart';

class RemoteMcpImportView extends StatefulWidget {
  const RemoteMcpImportView({
    super.key,
    required this.enabled,
    required this.hasDraft,
    required this.draftVersion,
    required this.onApply,
    required this.onInspect,
  });
  final bool enabled;
  final ValueGetter<bool> hasDraft;
  final ValueGetter<Object> draftVersion;
  final ValueChanged<RemoteMcpCandidate> onApply;
  final Future<RemoteMcpImportResult> Function(RemoteMcpImportResult) onInspect;

  @override
  State<RemoteMcpImportView> createState() => _RemoteMcpImportViewState();
}

class _RemoteMcpImportViewState extends State<RemoteMcpImportView> {
  final source = TextEditingController();
  bool open = false, replace = false, inspecting = false;
  int revision = 0;
  Object? reviewedDraft;
  final selectionKey = GlobalKey();
  List<RemoteMcpCandidate> candidates = [];
  String? selected, error;
  int skipped = 0;

  void clear() {
    revision++;
    source.clear();
    open = false;
    replace = false;
    candidates = [];
    selected = null;
    error = null;
    skipped = 0;
    inspecting = false;
    reviewedDraft = null;
  }

  @override
  void didUpdateWidget(RemoteMcpImportView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.enabled) clear();
  }

  @override
  void dispose() {
    source.dispose();
    super.dispose();
  }

  Future<void> inspect() async {
    if (!widget.enabled || inspecting) return;
    final result = parseRemoteMcpImport(source.text);
    final ticket = ++revision;
    setState(() {
      // Keep only the safe projection; pasted configuration can contain secrets.
      source.clear();
      candidates = [];
      skipped = result.skipped;
      error = result.error;
      selected = null;
      replace = false;
      inspecting = result.error == null;
    });
    if (result.error != null) return;
    try {
      final preview = await widget.onInspect(result);
      if (!mounted || ticket != revision || !widget.enabled) return;
      setState(() {
        candidates = preview.candidates;
        skipped = preview.skipped;
        error = preview.error;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final selection = selectionKey.currentContext;
        if (!mounted || ticket != revision || selection == null) return;
        Scrollable.ensureVisible(
          selection,
          alignment: 0.2,
          duration: const Duration(milliseconds: 180),
        );
      });
    } catch (failure) {
      if (!mounted || ticket != revision || !widget.enabled) return;
      setState(
        () => error = failure is ApiException && failure.status == 404
            ? 'unavailable'
            : 'request',
      );
    } finally {
      if (mounted && ticket == revision) {
        setState(() => inspecting = false);
      }
    }
  }

  void apply() {
    if (!widget.enabled || inspecting) return;
    final candidate = candidates
        .where((entry) => entry.url == selected)
        .firstOrNull;
    if (candidate == null) return;
    final draft = widget.draftVersion();
    if (widget.hasDraft() && (!replace || reviewedDraft != draft)) {
      setState(() {
        replace = true;
        reviewedDraft = draft;
      });
      return;
    }
    widget.onApply(candidate);
    if (mounted) setState(clear);
  }

  @override
  Widget build(BuildContext context) {
    if (!open) {
      return Align(
        alignment: AlignmentDirectional.centerStart,
        child: OutlinedButton.icon(
          onPressed: widget.enabled ? () => setState(() => open = true) : null,
          icon: const Icon(Icons.data_object),
          label: Text(context.tr('mobileAppsImportOpen')),
        ),
      );
    }
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              context.tr('mobileAppsImportOpen'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(context.tr('mobileAppsImportHelp')),
            const SizedBox(height: 12),
            if (error != null)
              Semantics(
                liveRegion: true,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    context.tr('mobileAppsImportError_$error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              ),
            if (inspecting) ...[
              const LinearProgressIndicator(),
              const SizedBox(height: 8),
              Text(context.tr('mobileAppsImportInspectBusy')),
            ] else if (candidates.isEmpty)
              TextField(
                controller: source,
                enabled: widget.enabled,
                minLines: 4,
                maxLines: 6,
                maxLength: maxMcpImportLength,
                maxLengthEnforcement: MaxLengthEnforcement.none,
                keyboardType: TextInputType.multiline,
                enableSuggestions: false,
                autocorrect: false,
                onChanged: (_) => setState(() => error = null),
                decoration: InputDecoration(
                  labelText: context.tr('mobileAppsImportJson'),
                  alignLabelWithHint: true,
                ),
              )
            else ...[
              DropdownButtonFormField<String>(
                key: selectionKey,
                initialValue: selected,
                isExpanded: true,
                menuMaxHeight: 280,
                decoration: InputDecoration(
                  labelText: context.tr('mobileAppsImportChoose'),
                ),
                hint: Text(context.tr('mobileAppsImportChoosePlaceholder')),
                items: [
                  for (final candidate in candidates)
                    DropdownMenuItem(
                      value: candidate.url,
                      child: Text(
                        '${candidate.name} — ${candidate.url}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: widget.enabled
                    ? (value) => setState(() {
                        selected = value;
                        replace = false;
                        reviewedDraft = null;
                      })
                    : null,
              ),
              if (selected != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: SelectableText(selected!),
                ),
              if (skipped > 0)
                Text(
                  context
                      .tr('mobileAppsImportSkipped')
                      .replaceAll('{count}', '$skipped'),
                ),
              if (replace)
                Semantics(
                  liveRegion: true,
                  child: Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(context.tr('mobileAppsImportReplaceHelp')),
                  ),
                ),
            ],
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              alignment: WrapAlignment.end,
              children: [
                TextButton(
                  onPressed: () => setState(clear),
                  child: Text(context.tr('mobileAppsImportCancel')),
                ),
                OutlinedButton(
                  onPressed:
                      widget.enabled &&
                          !inspecting &&
                          (candidates.isEmpty
                              ? source.text.trim().isNotEmpty
                              : selected != null)
                      ? (candidates.isEmpty ? inspect : apply)
                      : null,
                  child: Text(
                    context.tr(
                      candidates.isEmpty
                          ? 'mobileAppsImportInspect'
                          : replace
                          ? 'mobileAppsImportReplace'
                          : 'mobileAppsImportApply',
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

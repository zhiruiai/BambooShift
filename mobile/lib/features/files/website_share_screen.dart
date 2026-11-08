import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'website_project_client.dart';
import 'website_share_data.dart';

class WebsiteShareScreen extends StatefulWidget {
  const WebsiteShareScreen({super.key, required this.project});

  final WebsiteProjectClient project;

  @override
  State<WebsiteShareScreen> createState() => _WebsiteShareScreenState();
}

class _WebsiteShareScreenState extends State<WebsiteShareScreen> {
  late final client = WebsiteShareClient(widget.project);
  WebsiteShare? share;
  List<WebsiteViewer>? members;
  WebsiteVisibility visibility = WebsiteVisibility.private;
  Set<String> selected = {};
  bool loading = true, saving = false, reviewed = false, rotate = false;
  bool membersFailed = false;
  String? error, feedback;
  int generation = 0;

  bool current(int ticket) => mounted && ticket == generation && client.active;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  void apply(WebsiteShare value) {
    share = value;
    visibility = value.visibility;
    selected = value.viewers.toSet();
    reviewed = rotate = false;
  }

  Future<void> load() async {
    if (!mounted || !client.active || saving) return;
    final ticket = ++generation;
    setState(() {
      loading = true;
      error = feedback = null;
      share = null;
      members = null;
      membersFailed = false;
    });
    if (client.team) unawaited(loadMembers(ticket));
    try {
      final value = await client.load();
      if (current(ticket)) setState(() => apply(value));
    } catch (cause) {
      if (current(ticket)) {
        setState(
          () => error =
              cause is ApiException &&
                  (cause.status == 403 || cause.status == 404)
              ? 'mobileWebsiteSharePermission'
              : 'mobileWebsiteShareLoadFailed',
        );
      }
    } finally {
      if (current(ticket)) setState(() => loading = false);
    }
  }

  Future<void> loadMembers(int ticket) async {
    try {
      final result = await client.viewers();
      if (current(ticket)) setState(() => members = result);
    } catch (_) {
      if (current(ticket)) setState(() => membersFailed = true);
    }
  }

  void retryMembers() {
    if (!client.active || saving || !membersFailed) return;
    setState(() => membersFailed = false);
    unawaited(loadMembers(generation));
  }

  List<String> get viewers => (members ?? const <WebsiteViewer>[])
      .where((item) => selected.contains(item.id))
      .map((item) => item.id)
      .toList();

  bool get changed {
    final previous = share;
    return previous != null &&
        (previous.visibility != visibility ||
            rotate ||
            (visibility != WebsiteVisibility.private &&
                previous.versionId != widget.project.project.id) ||
            (visibility == WebsiteVisibility.invited &&
                members != null &&
                !setEquals(viewers.toSet(), previous.viewers.toSet())));
  }

  bool get canSave =>
      client.active &&
      changed &&
      !saving &&
      (visibility != WebsiteVisibility.public || reviewed) &&
      (visibility != WebsiteVisibility.invited ||
          (members != null && viewers.length <= maxWebsiteShareViewers));

  Future<void> save() async {
    final previous = share;
    if (previous == null || !canSave) return;
    final ticket = generation;
    setState(() {
      saving = true;
      error = feedback = null;
    });
    try {
      final result = await client.save(
        previous: previous,
        visibility: visibility,
        viewers: viewers,
        rotate: rotate,
      );
      if (current(ticket)) {
        setState(() {
          apply(result);
          feedback = 'mobileWebsiteShareSaved';
        });
      }
    } catch (cause) {
      if (current(ticket)) {
        setState(() {
          final conflict = cause is ApiException && cause.status == 409;
          share = null;
          error = conflict
              ? 'mobileWebsiteShareConflict'
              : 'mobileWebsiteShareSaveFailed';
        });
      }
    } finally {
      if (mounted && ticket == generation) setState(() => saving = false);
    }
  }

  Future<void> copy(Uri uri) async {
    if (!canUseLink(uri)) return;
    try {
      await Clipboard.setData(ClipboardData(text: uri.toString()));
      if (mounted && client.active) {
        setState(() => feedback = 'mobileWebsiteShareCopied');
      }
    } catch (_) {
      if (mounted && client.active) {
        setState(() => feedback = 'mobileWebsiteShareOpenFailed');
      }
    }
  }

  Future<void> open(Uri uri) async {
    if (!canUseLink(uri)) return;
    try {
      if (await launchUrl(uri, mode: LaunchMode.externalApplication)) return;
    } catch (_) {}
    if (mounted && client.active) {
      setState(() => feedback = 'mobileWebsiteShareOpenFailed');
    }
  }

  Future<void> sendLink(BuildContext anchor, Uri uri) async {
    if (!canUseLink(uri)) return;
    final box = anchor.findRenderObject();
    final origin = box is RenderBox && box.hasSize
        ? box.localToGlobal(Offset.zero) & box.size
        : null;
    try {
      await SharePlus.instance.share(
        ShareParams(uri: uri, sharePositionOrigin: origin),
      );
    } catch (_) {
      if (mounted && client.active) {
        setState(() => feedback = 'mobileWebsiteShareOpenFailed');
      }
    }
  }

  bool canUseLink(Uri uri) =>
      !saving && !changed && client.address(share) == uri;

  Widget linkActions(BuildContext context, Uri link) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Divider(),
      SelectableText(
        link.toString(),
        style: Theme.of(context).textTheme.bodySmall,
      ),
      Wrap(
        spacing: 8,
        children: [
          OutlinedButton.icon(
            onPressed: () => copy(link),
            icon: const Icon(Icons.copy_outlined),
            label: Text(context.tr('mobileWebsiteShareCopy')),
          ),
          OutlinedButton.icon(
            onPressed: () => open(link),
            icon: const Icon(Icons.open_in_new),
            label: Text(context.tr('mobileWebsiteShareOpen')),
          ),
          if (!kIsWeb)
            Builder(
              builder: (anchor) => OutlinedButton.icon(
                onPressed: () => sendLink(anchor, link),
                icon: const Icon(Icons.ios_share),
                label: Text(context.tr('mobileWebsiteShareSend')),
              ),
            ),
        ],
      ),
    ],
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      widget.project.scope,
      widget.project.scope.session,
    ]),
    builder: (context, _) {
      final link = client.address(share);
      final previousVersion = share?.versionId;
      final isActive = client.active;
      final selectedCount = viewers.length;
      return PopScope(
        canPop: !saving,
        child: Scaffold(
          appBar: AppBar(title: Text(context.tr('mobileWebsiteShare'))),
          bottomNavigationBar: isActive && share != null
              ? SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                    child: FilledButton(
                      onPressed: canSave ? save : null,
                      child: Text(
                        context.tr(
                          visibility == WebsiteVisibility.private &&
                                  link != null
                              ? 'mobileWebsiteShareRevoke'
                              : 'mobileWebsiteShareSave',
                        ),
                      ),
                    ),
                  ),
                )
              : null,
          body: !isActive
              ? const Notice('scopeChanged')
              : loading
              ? const Center(child: CircularProgressIndicator())
              : SafeArea(
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Text(
                        widget.project.project.title,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      if (error != null)
                        Notice(error!, action: 'retry', onAction: load),
                      if (share != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          context.tr('mobileWebsiteShareWho'),
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        RadioGroup<WebsiteVisibility>(
                          groupValue: visibility,
                          onChanged: (choice) {
                            if (choice == null || saving) return;
                            setState(() {
                              visibility = choice;
                              rotate = reviewed = false;
                              feedback = null;
                            });
                          },
                          child: Column(
                            children: [
                              for (final item in WebsiteVisibility.values)
                                if (client.team ||
                                    item == WebsiteVisibility.private ||
                                    item == WebsiteVisibility.public)
                                  RadioListTile<WebsiteVisibility>(
                                    value: item,
                                    enabled: !saving,
                                    title: Text(
                                      context.tr(
                                        websiteVisibilityLabels[item]!,
                                      ),
                                    ),
                                  ),
                            ],
                          ),
                        ),
                        if (visibility == WebsiteVisibility.invited) ...[
                          Text(
                            context.tr('mobileWebsiteShareViewers'),
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          Text(context.tr('mobileWebsiteShareViewerLimit')),
                          if (membersFailed)
                            Notice(
                              'mobileWebsiteShareViewersFailed',
                              action: 'retry',
                              onAction: retryMembers,
                            )
                          else if (members == null)
                            const Center(child: CircularProgressIndicator())
                          else ...[
                            if (members!.isEmpty)
                              Text(context.tr('mobileWebsiteShareNoViewers')),
                            for (final member in members!)
                              CheckboxListTile(
                                value: selected.contains(member.id),
                                title: Text(member.name),
                                onChanged:
                                    saving ||
                                        (selectedCount >=
                                                maxWebsiteShareViewers &&
                                            !selected.contains(member.id))
                                    ? null
                                    : (chosen) => setState(() {
                                        if (chosen == true) {
                                          selected.add(member.id);
                                        } else {
                                          selected.remove(member.id);
                                        }
                                      }),
                              ),
                          ],
                        ],
                        if (visibility != WebsiteVisibility.private)
                          Text(
                            context.tr(
                              previousVersion != null &&
                                      previousVersion !=
                                          widget.project.project.id
                                  ? 'mobileWebsiteShareVersionUpdate'
                                  : 'mobileWebsiteSharePinned',
                            ),
                          ),
                        if (changed && visibility == WebsiteVisibility.public)
                          CheckboxListTile(
                            value: reviewed,
                            onChanged: saving
                                ? null
                                : (value) =>
                                      setState(() => reviewed = value == true),
                            title: Text(
                              context.tr('mobileWebsiteShareConfirm'),
                            ),
                          ),
                        if (link != null) ...[
                          if (!changed && !saving) linkActions(context, link),
                          if (visibility != WebsiteVisibility.private)
                            CheckboxListTile(
                              value: rotate,
                              onChanged: saving
                                  ? null
                                  : (value) =>
                                        setState(() => rotate = value == true),
                              title: Text(
                                context.tr('mobileWebsiteShareRotate'),
                              ),
                            ),
                        ],
                      ],
                      if (feedback != null) Notice(feedback!),
                    ],
                  ),
                ),
        ),
      );
    },
  );
}

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'model_profile_data.dart';
import 'model_profiles_controller.dart';

class ModelProfileEditor extends StatefulWidget {
  const ModelProfileEditor({
    super.key,
    required this.controller,
    this.profile,
    this.copy = false,
  });
  final ModelProfilesController controller;
  final Json? profile;
  final bool copy;
  @override
  State<ModelProfileEditor> createState() => _ModelProfileEditorState();
}

class _ModelProfileEditorState extends State<ModelProfileEditor> {
  final form = GlobalKey<FormState>();
  final name = TextEditingController(),
      provider = TextEditingController(),
      model = TextEditingController();
  final endpoint = TextEditingController(), secret = TextEditingController();
  bool vision = false, clearKey = false;
  String? error;
  bool get existing => widget.profile != null && !widget.copy;
  Json get fields => {
    'name': name.text.trim(),
    'provider': provider.text.trim(),
    'model': model.text.trim(),
    'baseUrl': endpoint.text.trim(),
    'vision': vision,
    if (secret.text.trim().isNotEmpty) 'apiKey': secret.text.trim(),
    if (clearKey && existing) 'clearApiKey': true,
  };
  bool get endpointChanged =>
      existing &&
      (provider.text.trim() != widget.profile!['provider'] ||
          endpoint.text.trim().replaceAll(RegExp(r'/+$'), '') !=
              widget.profile!['baseUrl']);
  @override
  void initState() {
    super.initState();
    final value = widget.profile ?? newModel();
    name.text = value['name'] as String;
    provider.text = value['provider'] as String;
    model.text = value['model'] as String;
    endpoint.text = value['baseUrl'] as String;
    vision = value['vision'] == true;
    widget.controller.scope.session.addListener(identityChanged);
  }

  void identityChanged() {
    if (!widget.controller.active || !widget.controller.scope.owner) {
      secret.clear();
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.controller.scope.session.removeListener(identityChanged);
    secret.clear();
    for (final field in [name, provider, model, endpoint, secret]) {
      field.dispose();
    }
    super.dispose();
  }

  Future<void> save() async {
    if (!widget.controller.canManage || !form.currentState!.validate()) return;
    setState(() => error = null);
    try {
      final result = await widget.controller.write(
        existing ? 'save' : 'create',
        id: existing ? widget.profile!['id'] as String : null,
        fields: fields,
      );
      if (!mounted || !widget.controller.active) return;
      if (result != null) {
        secret.clear();
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted && widget.controller.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    }
  }

  Future<void> acknowledge() async {
    if (!await confirm(context, 'mobileModelsAcknowledgeConfirm')) return;
    if (!mounted || !widget.controller.active) return;
    if (await widget.controller.acknowledge() &&
        mounted &&
        widget.controller.active) {
      secret.clear();
      Navigator.pop(context);
    }
  }

  Widget field(
    TextEditingController input,
    String label,
    int limit, {
    bool key = false,
    bool address = false,
    String? Function(String?)? validator,
    ValueChanged<String>? onChanged,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: TextFormField(
      controller: input,
      enabled: widget.controller.canManage,
      maxLength: limit,
      obscureText: key,
      autocorrect: false,
      enableSuggestions: !key,
      keyboardType: address ? TextInputType.url : TextInputType.text,
      decoration: InputDecoration(labelText: context.tr(label)),
      validator: validator,
      onChanged: onChanged,
    ),
  );
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      if (!c.active) return const Scaffold(body: Notice('scopeChanged'));
      final editable = c.canManage;
      return Scaffold(
        appBar: AppBar(
          title: Text(
            context.tr(existing ? 'mobileModelsEdit' : 'mobileModelsNew'),
          ),
        ),
        body: Form(
          key: form,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (!c.scope.owner) const Notice('mobileModelsMemberReadOnly'),
              if (widget.copy) const Notice('mobileModelsCopyNoKey'),
              if (existing && c.activeId == widget.profile!['id'])
                const Notice('mobileModelsEditingDefault'),
              if (c.error != null) Notice(c.error!),
              if (error != null) Notice(error!),
              if (c.pending != null) ...[
                const Notice('mobileModelsUnknown'),
                Wrap(
                  spacing: 8,
                  children: [
                    TextButton(
                      onPressed: c.busy || c.loading ? null : c.refresh,
                      child: Text(context.tr('mobileModelsCheck')),
                    ),
                    TextButton(
                      onPressed: c.checked && !c.busy && !c.loading
                          ? acknowledge
                          : null,
                      child: Text(context.tr('mobileModelsAcknowledge')),
                    ),
                  ],
                ),
              ],
              field(
                name,
                'name',
                80,
                validator: (v) =>
                    (v ?? '').trim().isEmpty ? context.tr('required') : null,
              ),
              field(
                provider,
                'provider',
                80,
                validator: (v) =>
                    RegExp(r'^[A-Za-z0-9_-]+$').hasMatch((v ?? '').trim())
                    ? null
                    : context.tr('mobileModelsProviderInvalid'),
                onChanged: (_) {
                  secret.clear();
                  setState(() => clearKey = false);
                },
              ),
              field(
                model,
                'mobileModelsModelId',
                200,
                validator: (v) =>
                    (v ?? '').trim().isEmpty ? context.tr('required') : null,
              ),
              field(
                endpoint,
                'modelEndpoint',
                2048,
                address: true,
                validator: (v) {
                  final problem = endpointProblem(v ?? '');
                  return problem == null ? null : context.tr(problem);
                },
                onChanged: (_) {
                  secret.clear();
                  setState(() => clearKey = false);
                },
              ),
              if (endpointChanged) const Notice('mobileModelsEndpointChanged'),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: vision,
                title: Text(context.tr('vision')),
                onChanged: editable ? (v) => setState(() => vision = v) : null,
              ),
              if (c.scope.owner) ...[
                field(
                  secret,
                  'apiKey',
                  16384,
                  key: true,
                  validator: (v) => RegExp(r'[\r\n\x00]').hasMatch(v ?? '')
                      ? context.tr('mobileModelsKeyInvalid')
                      : null,
                  onChanged: (_) {
                    if (clearKey) setState(() => clearKey = false);
                  },
                ),
                Notice(
                  existing && !endpointChanged
                      ? 'mobileModelsKeepKey'
                      : 'mobileModelsNewKey',
                ),
                if (existing &&
                    widget.profile!['hasApiKey'] == true &&
                    !endpointChanged)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: clearKey,
                    title: Text(
                      context.tr('mobileModelsClearKey'),
                      style: const TextStyle(fontSize: 14),
                    ),
                    onChanged: editable
                        ? (v) {
                            secret.clear();
                            setState(() => clearKey = v == true);
                          }
                        : null,
                  ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: editable ? save : null,
                  child: Text(context.tr('mobileModelsSave')),
                ),
              ],
            ],
          ),
        ),
      );
    },
  );
}

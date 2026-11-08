import 'package:flutter/material.dart';

import '../../core/app_session.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'server_screen.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.session});
  final AppSession session;
  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController(),
      _password = TextEditingController(),
      _name = TextEditingController(),
      _team = TextEditingController();
  bool _register = false, _isTeam = false, _hidden = true;
  @override
  void dispose() {
    for (final c in [_email, _password, _name, _team]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    await widget.session.authenticate({
      'email': _email.text.trim(),
      'password': _password.text,
      if (_register) ...{
        'name': _name.text.trim(),
        'kind': _isTeam ? 'team' : 'personal',
        if (_isTeam) 'teamName': _team.text.trim(),
      },
    }, register: _register);
    if (mounted && widget.session.user != null) _password.clear();
  }

  Widget _field(
    TextEditingController c,
    String label, {
    int? max,
    TextInputType? type,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: TextFormField(
      controller: c,
      maxLength: max,
      keyboardType: type,
      enabled: !widget.session.busy,
      decoration: InputDecoration(
        labelText: context.tr(label),
        counterText: '',
      ),
      validator: (v) =>
          v == null || v.trim().isEmpty ? context.tr('required') : null,
    ),
  );
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.session,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        title: Text(context.tr('appName')),
        actions: [
          IconButton(
            tooltip: context.tr('changeServer'),
            onPressed: widget.session.busy
                ? null
                : () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          ServerScreen(session: widget.session, canClose: true),
                    ),
                  ),
            icon: const Icon(Icons.dns_outlined),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      context.tr('tagline'),
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 24),
                    SegmentedButton<bool>(
                      segments: [
                        ButtonSegment(
                          value: false,
                          label: Text(context.tr('signIn')),
                        ),
                        ButtonSegment(
                          value: true,
                          label: Text(context.tr('register')),
                        ),
                      ],
                      selected: {_register},
                      onSelectionChanged: widget.session.busy
                          ? null
                          : (v) => setState(() => _register = v.first),
                    ),
                    const SizedBox(height: 24),
                    if (_register) _field(_name, 'name', max: 60),
                    _field(
                      _email,
                      'email',
                      type: TextInputType.emailAddress,
                      max: 254,
                    ),
                    TextFormField(
                      controller: _password,
                      obscureText: _hidden,
                      autocorrect: false,
                      enableSuggestions: false,
                      enabled: !widget.session.busy,
                      maxLength: 128,
                      autofillHints: [
                        _register
                            ? AutofillHints.newPassword
                            : AutofillHints.password,
                      ],
                      decoration: InputDecoration(
                        labelText: context.tr('password'),
                        helperText: _register
                            ? context.tr('passwordHint')
                            : null,
                        counterText: '',
                        suffixIcon: IconButton(
                          onPressed: () => setState(() => _hidden = !_hidden),
                          icon: Icon(
                            _hidden
                                ? Icons.visibility_outlined
                                : Icons.visibility_off_outlined,
                          ),
                        ),
                      ),
                      validator: (v) =>
                          v == null || v.isEmpty || (_register && v.length < 10)
                          ? context.tr('passwordHint')
                          : null,
                      onFieldSubmitted: (_) => _submit(),
                    ),
                    if (_register) ...[
                      const SizedBox(height: 20),
                      Text(context.tr('accountType')),
                      const SizedBox(height: 8),
                      SegmentedButton<bool>(
                        segments: [
                          ButtonSegment(
                            value: false,
                            label: Text(context.tr('personal')),
                            icon: const Icon(Icons.person_outline),
                          ),
                          ButtonSegment(
                            value: true,
                            label: Text(context.tr('team')),
                            icon: const Icon(Icons.group_outlined),
                          ),
                        ],
                        selected: {_isTeam},
                        onSelectionChanged: widget.session.busy
                            ? null
                            : (v) => setState(() => _isTeam = v.first),
                      ),
                      const SizedBox(height: 16),
                      if (_isTeam) _field(_team, 'teamName', max: 80),
                    ],
                    if (widget.session.error != null)
                      Notice(widget.session.error!),
                    const SizedBox(height: 20),
                    FilledButton(
                      onPressed: widget.session.busy ? null : _submit,
                      child: Text(
                        context.tr(
                          widget.session.busy
                              ? 'working'
                              : _register
                              ? 'register'
                              : 'signIn',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

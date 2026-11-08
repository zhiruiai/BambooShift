import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'library_data.dart';
import '../routines/routine_form.dart';

class BlueprintEditor extends StatefulWidget {
  const BlueprintEditor({super.key, required this.initial});
  final Json initial;
  @override
  State<BlueprintEditor> createState() => _BlueprintEditorState();
}

class _BlueprintEditorState extends State<BlueprintEditor> {
  final form = GlobalKey<FormState>();
  late final Json draft = libraryCopy(widget.initial);
  bool leaving = false, dirty = false;
  String? error;
  Json get profile => draft['profile'];
  List get skills => draft['skills'];
  List get routines => draft['routines'];
  Widget text(
    Json row,
    String key,
    String label,
    int limit, {
    bool required = false,
    int lines = 1,
  }) => TextFormField(
    key: ValueKey('${identityHashCode(row)}:$key'),
    initialValue: row[key] ?? '',
    decoration: InputDecoration(labelText: context.tr(label)),
    maxLength: limit,
    minLines: lines,
    maxLines: lines == 1 ? 1 : lines + 4,
    validator: (v) => !libraryText(v, limit, empty: !required)
        ? context.tr('required')
        : null,
    onChanged: (v) {
      row[key] = v;
      dirty = true;
    },
  );
  Future<void> leave() async {
    if (dirty && !await confirm(context, 'mobileLibraryEditDiscard')) return;
    if (mounted) {
      setState(() => leaving = true);
      Navigator.pop(context);
    }
  }

  void save() {
    if (!form.currentState!.validate()) return;
    try {
      final result = blueprint(draft);
      setState(() => leaving = true);
      Navigator.pop(context, result);
    } catch (_) {
      setState(() => error = 'mobileLibraryInvalid');
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: leaving,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) leave();
    },
    child: Scaffold(
      appBar: AppBar(title: Text(context.tr('mobileLibraryEditDraft'))),
      body: Form(
        key: form,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Notice('mobileLibraryDraftOnly'),
            if (error != null) Notice(error!),
            text(profile, 'name', 'name', 40, required: true),
            text(profile, 'role', 'role', 80, required: true),
            text(profile, 'description', 'description', 1000, lines: 3),
            text(profile, 'instructions', 'instructions', 16000, lines: 6),
            DropdownButtonFormField<String>(
              initialValue: profile['avatar'],
              isExpanded: true,
              decoration: InputDecoration(
                labelText: context.tr('mobileLibraryShape'),
              ),
              items: [
                for (final a in ['orb', 'drop', 'leaf', 'spark', 'gem', 'arch'])
                  DropdownMenuItem(
                    value: a,
                    child: Text(context.tr('mobileLibraryShape_$a')),
                  ),
              ],
              onChanged: (v) {
                if (v != null) {
                  setState(() {
                    profile['avatar'] = v;
                    dirty = true;
                  });
                }
              },
            ),
            TextFormField(
              initialValue: profile['color'],
              maxLength: 7,
              decoration: InputDecoration(
                labelText: context.tr('mobileLibraryColor'),
              ),
              validator: (v) =>
                  v != null && RegExp(r'^#[a-fA-F0-9]{6}$').hasMatch(v)
                  ? null
                  : context.tr('mobileLibraryInvalidColor'),
              onChanged: (v) {
                profile['color'] = v;
                dirty = true;
              },
            ),
            if (widget.initial['avatar'] != null)
              SwitchListTile(
                title: Text(context.tr('mobileLibraryKeepImage')),
                value: draft['avatar'] != null,
                onChanged: (v) => setState(() {
                  if (v) {
                    draft['avatar'] = libraryCopy(widget.initial['avatar']);
                  } else {
                    draft.remove('avatar');
                  }
                  dirty = true;
                }),
              ),
            const SizedBox(height: 16),
            Text(
              context.tr('skills'),
              style: Theme.of(context).textTheme.titleLarge,
            ),
            for (final row in List<Json>.from(skills))
              Card(
                key: ObjectKey(row),
                child: ExpansionTile(
                  title: Text(row['name'] as String),
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        children: [
                          text(row, 'name', 'name', 100, required: true),
                          text(
                            row,
                            'description',
                            'description',
                            1000,
                            lines: 2,
                          ),
                          text(
                            row,
                            'content',
                            'mobileLibrarySkillContent',
                            16000,
                            required: true,
                            lines: 5,
                          ),
                          TextButton.icon(
                            onPressed: () => setState(() {
                              skills.remove(row);
                              dirty = true;
                            }),
                            icon: const Icon(Icons.delete_outline),
                            label: Text(context.tr('mobileLibraryRemoveItem')),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            OutlinedButton.icon(
              onPressed: skills.length >= 100
                  ? null
                  : () => setState(() {
                      skills.add(<String, dynamic>{
                        'name': '',
                        'description': '',
                        'content': '',
                      });
                      dirty = true;
                    }),
              icon: const Icon(Icons.add),
              label: Text(context.tr('mobileLibraryAddSkill')),
            ),
            const SizedBox(height: 16),
            Text(
              context.tr('routines'),
              style: Theme.of(context).textTheme.titleLarge,
            ),
            for (final row in List<Json>.from(routines))
              Card(
                key: ObjectKey(row),
                child: ExpansionTile(
                  title: Text(row['title'] as String),
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        children: [
                          RoutineForm(
                            key: ObjectKey(row),
                            initial: row,
                            enabled: true,
                            onChanged: (value) {
                              row.addAll(value);
                              dirty = true;
                            },
                          ),
                          TextButton.icon(
                            onPressed: () => setState(() {
                              routines.remove(row);
                              dirty = true;
                            }),
                            icon: const Icon(Icons.delete_outline),
                            label: Text(context.tr('mobileLibraryRemoveItem')),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            OutlinedButton.icon(
              onPressed: routines.length >= 100
                  ? null
                  : () => setState(() {
                      routines.add(<String, dynamic>{
                        'title': '',
                        'prompt': '',
                        'schedule': 'daily:09:00',
                        'timeZone': 'Asia/Shanghai',
                        'enabled': false,
                      });
                      dirty = true;
                    }),
              icon: const Icon(Icons.add),
              label: Text(context.tr('mobileLibraryAddRoutine')),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: save,
              child: Text(context.tr('mobileLibraryReviewChanges')),
            ),
          ],
        ),
      ),
    ),
  );
}
